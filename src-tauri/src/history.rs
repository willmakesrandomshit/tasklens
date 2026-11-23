//! Local, bounded resource history in SQLite (nothing leaves the machine).
//!
//! One row per sample (default every 5 s). Top-process rows are written only while a sample is
//! "elevated", so quiet periods cost almost nothing. Retention is enforced by age and by file size.

use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct Sample {
    pub ts: i64,
    pub cpu: f64,
    pub mem: f64,
    pub gpu: Option<f64>,
    pub disk_active: Option<f64>,
    pub disk_read: f64,
    pub disk_write: f64,
    pub net_rx: f64,
    pub net_tx: f64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProcBrief {
    pub pid: u32,
    pub identity: Option<String>,
    pub name: String,
    pub cpu: f32,
    pub mem: u64,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct ProcEvent {
    pub ts: i64,
    /// "start" or "exit"
    pub kind: String,
    pub pid: u32,
    pub name: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct Stats {
    pub samples: i64,
    pub bytes: u64,
    pub oldest: Option<i64>,
    pub newest: Option<i64>,
}

#[derive(Serialize, Clone, Debug)]
pub struct Spike {
    pub ts: i64,
    pub metric: &'static str,
    pub value: f64,
    /// Median of the surrounding range, for context.
    pub baseline: f64,
    /// Processes that were using the most CPU/memory at that moment. This is correlation: being busy
    /// at the same time does not prove a process caused the spike.
    pub processes: Vec<ProcBrief>,
}

pub struct History {
    conn: Connection,
    path: PathBuf,
}

/// A sample is "elevated" when something notable is happening; only then are top processes stored.
pub fn is_elevated(s: &Sample) -> bool {
    s.cpu >= 50.0
        || s.mem >= 80.0
        || s.gpu.is_some_and(|g| g >= 50.0)
        || s.disk_active.is_some_and(|d| d >= 70.0)
}

impl History {
    pub fn open(path: &Path) -> Result<History, String> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let conn = Connection::open(path).map_err(|e| format!("Could not open history: {e}"))?;
        conn.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;
             CREATE TABLE IF NOT EXISTS samples(ts INTEGER PRIMARY KEY, cpu REAL, mem REAL, gpu REAL,
                 disk_active REAL, disk_read REAL, disk_write REAL, net_rx REAL, net_tx REAL);
             CREATE TABLE IF NOT EXISTS top(ts INTEGER, pid INTEGER, identity TEXT, name TEXT, cpu REAL, mem INTEGER);
             CREATE INDEX IF NOT EXISTS top_ts ON top(ts);
             CREATE TABLE IF NOT EXISTS events(ts INTEGER, kind TEXT, pid INTEGER, name TEXT);
             CREATE INDEX IF NOT EXISTS events_ts ON events(ts);",
        )
        .map_err(|e| format!("Could not prepare history: {e}"))?;
        Ok(History {
            conn,
            path: path.to_path_buf(),
        })
    }

    pub fn record(
        &mut self,
        s: &Sample,
        tops: &[ProcBrief],
        events: &[ProcEvent],
    ) -> Result<(), String> {
        let tx = self.conn.transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR REPLACE INTO samples VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![
                s.ts,
                s.cpu,
                s.mem,
                s.gpu,
                s.disk_active,
                s.disk_read,
                s.disk_write,
                s.net_rx,
                s.net_tx
            ],
        )
        .map_err(|e| e.to_string())?;
        if is_elevated(s) {
            for p in tops {
                tx.execute(
                    "INSERT INTO top VALUES (?1,?2,?3,?4,?5,?6)",
                    params![s.ts, p.pid, p.identity, p.name, p.cpu as f64, p.mem as i64],
                )
                .map_err(|e| e.to_string())?;
            }
        }
        for e in events.iter().take(40) {
            tx.execute(
                "INSERT INTO events VALUES (?1,?2,?3,?4)",
                params![e.ts, e.kind, e.pid, e.name],
            )
            .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    pub fn samples(&self, from: i64, to: i64) -> Result<Vec<Sample>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT ts,cpu,mem,gpu,disk_active,disk_read,disk_write,net_rx,net_tx FROM samples WHERE ts BETWEEN ?1 AND ?2 ORDER BY ts")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![from, to], |r| {
                Ok(Sample {
                    ts: r.get(0)?,
                    cpu: r.get(1)?,
                    mem: r.get(2)?,
                    gpu: r.get(3)?,
                    disk_active: r.get(4)?,
                    disk_read: r.get(5)?,
                    disk_write: r.get(6)?,
                    net_rx: r.get(7)?,
                    net_tx: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    /// Downsamples to at most `max_points` buckets. Percent metrics keep the bucket MAX so short
    /// spikes survive downsampling; throughput metrics use the bucket average.
    pub fn query(&self, from: i64, to: i64, max_points: i64) -> Result<Vec<Sample>, String> {
        let bucket = ((to - from) / max_points.max(1)).max(1);
        let mut stmt = self
            .conn
            .prepare(
                "SELECT (ts/?3)*?3, MAX(cpu), MAX(mem), MAX(gpu), MAX(disk_active),
                        AVG(disk_read), AVG(disk_write), AVG(net_rx), AVG(net_tx)
                 FROM samples WHERE ts BETWEEN ?1 AND ?2 GROUP BY ts/?3 ORDER BY 1",
            )
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![from, to, bucket], |r| {
                Ok(Sample {
                    ts: r.get(0)?,
                    cpu: r.get(1)?,
                    mem: r.get(2)?,
                    gpu: r.get(3)?,
                    disk_active: r.get(4)?,
                    disk_read: r.get(5)?,
                    disk_write: r.get(6)?,
                    net_rx: r.get(7)?,
                    net_tx: r.get(8)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn events(&self, from: i64, to: i64, limit: i64) -> Result<Vec<ProcEvent>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT ts,kind,pid,name FROM events WHERE ts BETWEEN ?1 AND ?2 ORDER BY ts DESC LIMIT ?3")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![from, to, limit], |r| {
                Ok(ProcEvent {
                    ts: r.get(0)?,
                    kind: r.get(1)?,
                    pid: r.get(2)?,
                    name: r.get(3)?,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn tops_at(&self, ts: i64) -> Result<Vec<ProcBrief>, String> {
        let mut stmt = self
            .conn
            .prepare("SELECT pid,identity,name,cpu,mem FROM top WHERE ts=?1 ORDER BY cpu DESC")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![ts], |r| {
                Ok(ProcBrief {
                    pid: r.get(0)?,
                    identity: r.get(1)?,
                    name: r.get(2)?,
                    cpu: r.get::<_, f64>(3)? as f32,
                    mem: r.get::<_, i64>(4)? as u64,
                })
            })
            .map_err(|e| e.to_string())?;
        rows.collect::<Result<_, _>>().map_err(|e| e.to_string())
    }

    pub fn spikes(&self, from: i64, to: i64) -> Result<Vec<Spike>, String> {
        let samples = self.samples(from, to)?;
        let mut spikes = detect_spikes(&samples);
        for s in &mut spikes {
            s.processes = self.tops_at(s.ts)?;
        }
        Ok(spikes)
    }

    pub fn stats(&self) -> Stats {
        let (samples, oldest, newest): (i64, Option<i64>, Option<i64>) = self
            .conn
            .query_row("SELECT COUNT(*), MIN(ts), MAX(ts) FROM samples", [], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?))
            })
            .unwrap_or((0, None, None));
        let size = |p: PathBuf| std::fs::metadata(p).map_or(0, |m| m.len());
        let wal = PathBuf::from(format!("{}-wal", self.path.display()));
        Stats {
            samples,
            bytes: size(self.path.clone()) + size(wal),
            oldest,
            newest,
        }
    }

    /// Deletes data older than the retention period, then trims the oldest data while the file is
    /// larger than `max_bytes`.
    pub fn purge(&mut self, now: i64, retention_days: u64, max_bytes: u64) -> Result<(), String> {
        let cutoff = now - (retention_days as i64) * 86_400;
        for table in ["samples", "top", "events"] {
            self.conn
                .execute(
                    &format!("DELETE FROM {table} WHERE ts < ?1"),
                    params![cutoff],
                )
                .map_err(|e| e.to_string())?;
        }
        let mut guard = 0;
        while self.stats().bytes > max_bytes && guard < 20 {
            guard += 1;
            let (oldest, newest) = match (self.stats().oldest, self.stats().newest) {
                (Some(o), Some(n)) => (o, n),
                _ => break,
            };
            let cut = oldest + ((newest - oldest) / 10).max(60);
            for table in ["samples", "top", "events"] {
                self.conn
                    .execute(&format!("DELETE FROM {table} WHERE ts < ?1"), params![cut])
                    .map_err(|e| e.to_string())?;
            }
            let _ = self
                .conn
                .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;");
        }
        Ok(())
    }

    pub fn clear(&mut self) -> Result<(), String> {
        self.conn
            .execute_batch("DELETE FROM samples; DELETE FROM top; DELETE FROM events; PRAGMA wal_checkpoint(TRUNCATE); VACUUM;")
            .map_err(|e| e.to_string())
    }

    pub fn export_csv(&self, from: i64, to: i64) -> Result<String, String> {
        let mut out = String::from("timestamp_utc,cpu_percent,memory_percent,gpu_percent,disk_active_percent,disk_read_bytes_per_s,disk_write_bytes_per_s,net_rx_bytes_per_s,net_tx_bytes_per_s\n");
        let opt = |v: Option<f64>| v.map_or(String::new(), |x| format!("{x:.2}"));
        for s in self.samples(from, to)? {
            out.push_str(&format!(
                "{},{:.2},{:.2},{},{},{:.0},{:.0},{:.0},{:.0}\n",
                s.ts,
                s.cpu,
                s.mem,
                opt(s.gpu),
                opt(s.disk_active),
                s.disk_read,
                s.disk_write,
                s.net_rx,
                s.net_tx
            ));
        }
        Ok(out)
    }
}

fn median(mut v: Vec<f64>) -> f64 {
    if v.is_empty() {
        return 0.0;
    }
    v.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    v[v.len() / 2]
}

/// Finds local maxima that are both high in absolute terms and clearly above the typical level.
/// Consecutive elevated samples collapse into one spike (the peak).
pub fn detect_spikes(samples: &[Sample]) -> Vec<Spike> {
    type Metric = (&'static str, f64, fn(&Sample) -> Option<f64>);
    let metrics: [Metric; 4] = [
        ("cpu", 80.0, |s| Some(s.cpu)),
        ("memory", 90.0, |s| Some(s.mem)),
        ("gpu", 80.0, |s| s.gpu),
        ("disk_active", 90.0, |s| s.disk_active),
    ];
    let mut out = Vec::new();
    for (name, abs, get) in metrics {
        let values: Vec<(i64, f64)> = samples
            .iter()
            .filter_map(|s| get(s).map(|v| (s.ts, v)))
            .collect();
        let base = median(values.iter().map(|v| v.1).collect());
        let limit = abs.max(base * 1.5);
        let mut peak: Option<(i64, f64)> = None;
        for &(ts, v) in &values {
            if v >= limit {
                if peak.is_none_or(|p| v > p.1) {
                    peak = Some((ts, v));
                }
            } else if let Some((pts, pv)) = peak.take() {
                out.push(Spike {
                    ts: pts,
                    metric: name,
                    value: pv,
                    baseline: base,
                    processes: Vec::new(),
                });
            }
        }
        if let Some((pts, pv)) = peak {
            out.push(Spike {
                ts: pts,
                metric: name,
                value: pv,
                baseline: base,
                processes: Vec::new(),
            });
        }
    }
    out.sort_by_key(|s| s.ts);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("tasklens-hist-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir.join("history.db")
    }

    fn sample(ts: i64, cpu: f64) -> Sample {
        Sample {
            ts,
            cpu,
            mem: 40.0,
            gpu: None,
            disk_active: Some(5.0),
            disk_read: 1000.0,
            disk_write: 500.0,
            net_rx: 200.0,
            net_tx: 100.0,
        }
    }

    fn brief(name: &str, cpu: f32) -> ProcBrief {
        ProcBrief {
            pid: 1,
            identity: Some("42".into()),
            name: name.into(),
            cpu,
            mem: 1 << 20,
        }
    }

    #[test]
    fn records_queries_and_downsamples_keeping_spikes() {
        let mut h = History::open(&temp_db("query")).unwrap();
        for i in 0..100 {
            let cpu = if i == 50 { 97.0 } else { 10.0 };
            h.record(&sample(1_000 + i, cpu), &[], &[]).unwrap();
        }
        assert_eq!(h.samples(0, i64::MAX).unwrap().len(), 100);
        let down = h.query(1_000, 1_099, 10).unwrap();
        assert!((9..=13).contains(&down.len()), "{}", down.len());
        assert!(
            down.iter().any(|p| p.cpu >= 97.0),
            "bucket MAX must preserve the spike"
        );
        assert!(
            down.iter().all(|p| p.gpu.is_none()),
            "missing GPU stays missing, never 0"
        );
    }

    #[test]
    fn top_processes_are_stored_only_for_elevated_samples() {
        let mut h = History::open(&temp_db("tops")).unwrap();
        h.record(&sample(10, 5.0), &[brief("quiet.exe", 1.0)], &[])
            .unwrap();
        h.record(&sample(20, 95.0), &[brief("busy.exe", 90.0)], &[])
            .unwrap();
        assert!(h.tops_at(10).unwrap().is_empty());
        assert_eq!(h.tops_at(20).unwrap()[0].name, "busy.exe");
    }

    #[test]
    fn spikes_carry_correlated_processes() {
        let mut h = History::open(&temp_db("spikes")).unwrap();
        for i in 0..60 {
            let cpu = if (30..33).contains(&i) { 96.0 } else { 8.0 };
            let tops = if cpu > 90.0 {
                vec![brief("render.exe", 80.0)]
            } else {
                vec![]
            };
            h.record(&sample(i, cpu), &tops, &[]).unwrap();
        }
        let spikes = h.spikes(0, 100).unwrap();
        let cpu: Vec<_> = spikes.iter().filter(|s| s.metric == "cpu").collect();
        assert_eq!(
            cpu.len(),
            1,
            "three consecutive samples collapse into one spike"
        );
        assert!(cpu[0].baseline < 20.0);
        assert_eq!(cpu[0].processes[0].name, "render.exe");
    }

    #[test]
    fn flat_high_load_is_not_a_spike() {
        let flat: Vec<Sample> = (0..50).map(|i| sample(i, 85.0)).collect();
        assert!(
            detect_spikes(&flat).iter().all(|s| s.metric != "cpu"),
            "constant 85% is the baseline"
        );
    }

    #[test]
    fn retention_and_clear_work_and_events_are_bounded() {
        let mut h = History::open(&temp_db("retention")).unwrap();
        let now = 10 * 86_400;
        h.record(&sample(100, 10.0), &[], &[]).unwrap();
        let events: Vec<ProcEvent> = (0..100)
            .map(|i| ProcEvent {
                ts: now,
                kind: "start".into(),
                pid: i,
                name: format!("p{i}"),
            })
            .collect();
        h.record(&sample(now, 10.0), &[], &events).unwrap();
        h.purge(now, 7, u64::MAX).unwrap();
        let stats = h.stats();
        assert_eq!(stats.samples, 1, "10-day-old row purged");
        assert_eq!(
            h.events(0, i64::MAX, 1000).unwrap().len(),
            40,
            "events per sample are capped"
        );
        h.clear().unwrap();
        assert_eq!(h.stats().samples, 0);
    }

    #[test]
    fn size_limit_trims_oldest_data() {
        let mut h = History::open(&temp_db("size")).unwrap();
        for i in 0..20_000 {
            h.record(&sample(i * 5, 10.0), &[], &[]).unwrap();
        }
        let before = h.stats().bytes;
        h.purge(20_000 * 5, 90, before / 2).unwrap();
        let after = h.stats();
        assert!(after.bytes < before, "{} !< {before}", after.bytes);
        assert!(after.samples < 20_000 && after.samples > 0);
    }

    #[test]
    fn csv_export_has_header_and_blank_for_unavailable() {
        let mut h = History::open(&temp_db("csv")).unwrap();
        h.record(&sample(1, 12.5), &[], &[]).unwrap();
        let csv = h.export_csv(0, 10).unwrap();
        let mut lines = csv.lines();
        assert!(lines
            .next()
            .unwrap()
            .starts_with("timestamp_utc,cpu_percent"));
        assert_eq!(
            lines.next().unwrap(),
            "1,12.50,40.00,,5.00,1000,500,200,100"
        );
    }
}
