import type { ProcessInfo, Snapshot } from './model';

export function proc(pid: number, name: string, over: Partial<ProcessInfo> = {}): ProcessInfo {
  return {
    pid, parent_pid: null, name, cpu_usage: 1, memory: 50 * 1024 * 1024, status: 'Run', start_time: 1000 + pid,
    identity: String(900000 + pid), exe: `C:\\Apps\\${name}`, command: `${name} --flag`, user: 'PC\\owner', thread_count: 4,
    handle_count: 120, priority: 'Normal', session_id: 1, architecture: 'x64', private_bytes: 40 * 1024 * 1024,
    peak_working_set: 60 * 1024 * 1024, io_read_bytes: 1000, io_write_bytes: 2000, cpu_time_ms: 5000,
    io_read_per_s: 100, io_write_per_s: 50, gpu_percent: 0, suspended: false, ...over,
  };
}

export function snapshot(processes: ProcessInfo[] = [proc(10, 'alpha.exe', { cpu_usage: 30 }), proc(20, 'beta.exe', { cpu_usage: 5, parent_pid: 10, start_time: 2000 }), proc(30, 'gamma.exe', { cpu_usage: 60 })]): Snapshot {
  return {
    timestamp: 1_700_000_000, cpu_usage: 42.5, cpu_cores: [10, 20, 30, 40], cpu_frequency_mhz: 3900,
    total_memory: 16 * 1024 ** 3, used_memory: 8 * 1024 ** 3, available_memory: 8 * 1024 ** 3, total_swap: 0, used_swap: 0,
    cpu_model: 'Test CPU 9000', logical_cores: 4, physical_cores: 2,
    memory_detail: { commit_total: 9e9, commit_limit: 2e10, commit_peak: 1e10, system_cache: 1e9, kernel_paged: 3e8, kernel_nonpaged: 2e8, handle_count: 5000, process_count: processes.length, thread_count: 900 },
    disks: [{ name: 'C:', mount: 'C:\\', file_system: 'NTFS', total: 1e12, available: 4e11 }],
    networks: [{ name: 'WiFi', received_per_s: 5000, transmitted_per_s: 1000, total_received: 1, total_transmitted: 1, addresses: ['192.168.1.5'], mtu: 1500 }],
    perf: { physical_disks: [{ name: '0 C:', active_percent: 12, response_ms: 0.4, read_per_s: 1000, write_per_s: 2000, queue_length: 0 }], memory_lists: { standby: 2e9, modified: 1e8, free: 3e9 } },
    net_adapters: [{ name: 'WiFi', description: 'Test Wi-Fi', status: 'Connected', kind: 'Wi-Fi', link_speed_bps: 866_000_000 }],
    gpu: { supported: false, live: [] }, gpu_adapters: [{ name: 'Test GPU', driver_version: '1.0', driver_date: '2026', provider: 'Test', dedicated_memory: 8 * 1024 ** 3 }],
    collect_ms: 12.5,
    processes,
  };
}
