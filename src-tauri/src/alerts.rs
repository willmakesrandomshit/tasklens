//! Threshold alerts with duration, cooldown and de-duplication. Alerts only notify; they never act on
//! processes. Unavailable metrics never trigger an alert.

use crate::settings::AlertRule;
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone, Debug, PartialEq)]
pub struct AlertEvent {
    pub ts: i64,
    pub rule_id: String,
    pub rule_name: String,
    pub metric: String,
    pub value: f64,
    pub message: String,
}

#[derive(Default)]
pub struct AlertState {
    breach_since: HashMap<String, i64>,
    last_fired: HashMap<String, i64>,
}

/// Inputs for one evaluation tick.
#[derive(Default, Clone, Debug)]
pub struct Metrics {
    pub cpu: f64,
    pub memory: f64,
    pub gpu: Option<f64>,
    pub disk_active: Option<f64>,
    /// Lowest free-space percentage across volumes.
    pub disk_free_min: Option<f64>,
    /// (lowercase image name, cpu percent) for every running process.
    pub processes: Vec<(String, f64)>,
    /// Lowercase image names that disappeared since the previous tick.
    pub exited: Vec<String>,
}

fn proc_key(rule: &AlertRule) -> Option<String> {
    rule.process
        .as_ref()
        .map(|p| p.trim().to_lowercase())
        .filter(|p| !p.is_empty())
}

/// The metric value for a rule, and whether crossing means "above" (true) or "below" (false).
fn reading(rule: &AlertRule, m: &Metrics) -> Option<(f64, bool)> {
    match rule.metric.as_str() {
        "cpu" => Some((m.cpu, true)),
        "memory" => Some((m.memory, true)),
        "gpu" => m.gpu.map(|v| (v, true)),
        "disk_active" => m.disk_active.map(|v| (v, true)),
        "disk_free" => m.disk_free_min.map(|v| (v, false)),
        "process_cpu" => {
            let name = proc_key(rule)?;
            m.processes
                .iter()
                .filter(|(n, _)| *n == name)
                .map(|(_, c)| *c)
                .reduce(f64::max)
                .map(|v| (v, true))
        }
        _ => None,
    }
}

fn describe(rule: &AlertRule, value: f64, above: bool) -> String {
    let what = match rule.metric.as_str() {
        "cpu" => "CPU usage".to_string(),
        "memory" => "Memory usage".to_string(),
        "gpu" => "GPU usage".to_string(),
        "disk_active" => "Disk active time".to_string(),
        "disk_free" => "Free disk space".to_string(),
        "process_cpu" => format!("{} CPU usage", rule.process.as_deref().unwrap_or("Process")),
        other => other.to_string(),
    };
    let hold = if rule.duration_s > 0 {
        format!(" for {} s", rule.duration_s)
    } else {
        String::new()
    };
    format!(
        "{what} is {value:.0}%, {} {:.0}%{hold}.",
        if above { "above" } else { "below" },
        rule.threshold
    )
}

pub fn evaluate(
    rules: &[AlertRule],
    state: &mut AlertState,
    m: &Metrics,
    now: i64,
) -> Vec<AlertEvent> {
    let mut fired = Vec::new();
    for rule in rules.iter().filter(|r| r.enabled) {
        let cooled = state
            .last_fired
            .get(&rule.id)
            .is_none_or(|t| now - t >= rule.cooldown_s as i64);
        let event = |value: f64, message: String| AlertEvent {
            ts: now,
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            metric: rule.metric.clone(),
            value,
            message,
        };
        if rule.metric == "process_exit" {
            let Some(name) = proc_key(rule) else { continue };
            if cooled && m.exited.contains(&name) {
                state.last_fired.insert(rule.id.clone(), now);
                fired.push(event(
                    0.0,
                    format!("{} exited.", rule.process.as_deref().unwrap_or(&name)),
                ));
            }
            continue;
        }
        let breaching = reading(rule, m).filter(|(v, above)| {
            if *above {
                *v > rule.threshold
            } else {
                *v < rule.threshold
            }
        });
        match breaching {
            Some((value, above)) => {
                let since = *state.breach_since.entry(rule.id.clone()).or_insert(now);
                if now - since >= rule.duration_s as i64 && cooled {
                    state.last_fired.insert(rule.id.clone(), now);
                    fired.push(event(value, describe(rule, value, above)));
                }
            }
            None => {
                state.breach_since.remove(&rule.id);
            }
        }
    }
    fired
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(metric: &str, threshold: f64, duration: u64, cooldown: u64) -> AlertRule {
        AlertRule {
            id: "r1".into(),
            name: "test".into(),
            metric: metric.into(),
            threshold,
            duration_s: duration,
            cooldown_s: cooldown,
            ..Default::default()
        }
    }
    fn cpu(v: f64) -> Metrics {
        Metrics {
            cpu: v,
            ..Default::default()
        }
    }

    #[test]
    fn requires_sustained_breach_then_respects_cooldown() {
        let rules = [rule("cpu", 90.0, 30, 300)];
        let mut st = AlertState::default();
        assert!(
            evaluate(&rules, &mut st, &cpu(95.0), 0).is_empty(),
            "just started"
        );
        assert!(
            evaluate(&rules, &mut st, &cpu(95.0), 29).is_empty(),
            "not long enough"
        );
        assert_eq!(
            evaluate(&rules, &mut st, &cpu(95.0), 30).len(),
            1,
            "fires after 30 s"
        );
        assert!(
            evaluate(&rules, &mut st, &cpu(95.0), 60).is_empty(),
            "cooldown suppresses repeats"
        );
        assert_eq!(
            evaluate(&rules, &mut st, &cpu(95.0), 331).len(),
            1,
            "fires again after cooldown"
        );
    }

    #[test]
    fn a_dip_resets_the_timer() {
        let rules = [rule("cpu", 90.0, 30, 10)];
        let mut st = AlertState::default();
        evaluate(&rules, &mut st, &cpu(95.0), 0);
        evaluate(&rules, &mut st, &cpu(10.0), 20);
        assert!(
            evaluate(&rules, &mut st, &cpu(95.0), 35).is_empty(),
            "timer restarted at 35"
        );
        assert_eq!(evaluate(&rules, &mut st, &cpu(95.0), 65).len(), 1);
    }

    #[test]
    fn unavailable_metrics_never_alert_and_disabled_rules_are_ignored() {
        let mut st = AlertState::default();
        let gpu = [rule("gpu", 50.0, 0, 10)];
        assert!(evaluate(
            &gpu,
            &mut st,
            &Metrics {
                gpu: None,
                ..Default::default()
            },
            0
        )
        .is_empty());
        let mut off = rule("cpu", 10.0, 0, 10);
        off.enabled = false;
        assert!(evaluate(&[off], &mut st, &cpu(99.0), 0).is_empty());
    }

    #[test]
    fn low_disk_space_alerts_when_below_threshold() {
        let rules = [rule("disk_free", 10.0, 0, 10)];
        let mut st = AlertState::default();
        let m = Metrics {
            disk_free_min: Some(4.0),
            ..Default::default()
        };
        let e = evaluate(&rules, &mut st, &m, 0);
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("below"));
        assert!(evaluate(
            &[rule("disk_free", 10.0, 0, 10)],
            &mut AlertState::default(),
            &Metrics {
                disk_free_min: Some(50.0),
                ..Default::default()
            },
            0
        )
        .is_empty());
    }

    #[test]
    fn process_rules_match_by_name_and_detect_exit() {
        let mut st = AlertState::default();
        let mut r = rule("process_cpu", 50.0, 0, 10);
        r.process = Some("Game.EXE".into());
        let m = Metrics {
            processes: vec![("game.exe".into(), 70.0), ("other.exe".into(), 99.0)],
            ..Default::default()
        };
        let e = evaluate(&[r], &mut st, &m, 0);
        assert_eq!(e.len(), 1);
        assert!(e[0].message.contains("Game.EXE"));
        let mut x = rule("process_exit", 0.0, 0, 10);
        x.id = "x".into();
        x.process = Some("game.exe".into());
        let gone = Metrics {
            exited: vec!["game.exe".into()],
            ..Default::default()
        };
        assert_eq!(evaluate(&[x], &mut st, &gone, 0).len(), 1);
    }
}
