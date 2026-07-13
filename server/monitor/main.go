package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─── 数据类型 ────────────────────────────────────────────────────────────────

type Stats struct {
	CPU       CPUStats       `json:"cpu"`
	Memory    MemoryStats    `json:"memory"`
	Uptime    float64        `json:"uptimeSec"`
	Process   ProcessStats   `json:"process"`
	Processes []ProcessInfo  `json:"processes"`
	Container ContainerStats `json:"container"`
	Time      int64          `json:"ts"`
}

type CPUStats struct {
	User   float64 `json:"userPct"`
	System float64 `json:"systemPct"`
	Idle   float64 `json:"idlePct"`
}

type MemoryStats struct {
	TotalMB     uint64  `json:"totalMB"`
	AvailableMB uint64  `json:"availableMB"`
	UsedMB      uint64  `json:"usedMB"`
	UsedPct     float64 `json:"usedPct"`
}

type ProcessStats struct {
	PID       int     `json:"pid"`
	CPUUser   float64 `json:"cpuUserSec"`
	CPUSystem float64 `json:"cpuSystemSec"`
	RSSMB     float64 `json:"rssMB"`
	HeapMB    float64 `json:"heapMB"`
	UptimeSec float64 `json:"uptimeSec"`
}

type ProcessInfo struct {
	PID        int     `json:"pid"`
	Name       string  `json:"name"`
	CPUUserPct float64 `json:"cpuUserPct"`
	CPUSysPct  float64 `json:"cpuSysPct"`
	RSSMB      float64 `json:"rssMB"`
	UptimeSec  float64 `json:"uptimeSec"`
}

type ContainerStats struct {
	CPUUserPct    float64 `json:"cpuUserPct"`
	CPUSystemPct  float64 `json:"cpuSystemPct"`
	CPUCores      float64 `json:"cpuCores"`
	MemoryUsedMB  uint64  `json:"memoryUsedMB"`
	MemoryLimitMB uint64  `json:"memoryLimitMB"`
	MemoryUsedPct float64 `json:"memoryUsedPct"`
}

type LogEntry struct {
	Time    string `json:"time"`
	Message string `json:"message"`
}

// ─── 环形缓冲区 ──────────────────────────────────────────────────────────────

type LogBuffer struct {
	mu    sync.Mutex
	lines []LogEntry
	cap   int
	pos   int
	full  bool
	ch    chan struct{} // 通知有新日志（非阻塞）
}

func NewLogBuffer(capacity int) *LogBuffer {
	if capacity <= 0 {
		capacity = 2000
	}
	return &LogBuffer{lines: make([]LogEntry, capacity), cap: capacity, ch: make(chan struct{}, 1)}
}

func (b *LogBuffer) Write(line string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.lines[b.pos] = LogEntry{Time: time.Now().Format(time.RFC3339), Message: line}
	b.pos++
	if b.pos >= b.cap {
		b.pos = 0
		b.full = true
	}
	// 非阻塞通知
	select {
	case b.ch <- struct{}{}:
	default:
	}
}

func (b *LogBuffer) NotifyCh() <-chan struct{} {
	return b.ch
}

func (b *LogBuffer) Tail(n int) []LogEntry {
	b.mu.Lock()
	defer b.mu.Unlock()
	if n <= 0 || n > b.cap {
		n = b.cap
	}
	if !b.full {
		if b.pos <= n {
			out := make([]LogEntry, b.pos)
			copy(out, b.lines[:b.pos])
			return out
		}
		out := make([]LogEntry, n)
		copy(out, b.lines[b.pos-n:b.pos])
		return out
	}
	// 环形已满：从 pos 开始取（最旧的在 pos）
	out := make([]LogEntry, n)
	if b.pos+n <= b.cap {
		copy(out, b.lines[b.pos:b.pos+n])
	} else {
		first := b.cap - b.pos
		copy(out[:first], b.lines[b.pos:])
		copy(out[first:], b.lines[:n-first])
	}
	return out
}

// ─── /proc 读取 ───────────────────────────────────────────────────────────────

func readProc(path string) (string, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(b)), nil
}

// readCPUJiffies 解析 /proc/stat 第一行，返回 user/system/idle 的 jiffies
func readCPUJiffies() (user, system, idle, total float64, err error) {
	line, err := readProc("/proc/stat")
	if err != nil {
		return 0, 0, 0, 0, err
	}
	fields := strings.Fields(line)
	if len(fields) < 5 || fields[0] != "cpu" {
		return 0, 0, 0, 0, fmt.Errorf("unexpected /proc/stat format")
	}
	for i := 1; i < len(fields) && i <= 8; i++ {
		v, _ := strconv.ParseFloat(fields[i], 64)
		total += v
		switch i {
		case 1:
			user = v
		case 3:
			system = v
		case 4:
			idle = v
		}
	}
	return
}

func readMemInfo() (total, available uint64, err error) {
	data, err := readProc("/proc/meminfo")
	if err != nil {
		return 0, 0, err
	}
	for _, line := range strings.Split(data, "\n") {
		if strings.HasPrefix(line, "MemTotal:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				total, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		} else if strings.HasPrefix(line, "MemAvailable:") {
			fields := strings.Fields(line)
			if len(fields) >= 2 {
				available, _ = strconv.ParseUint(fields[1], 10, 64)
			}
		}
	}
	return
}

func readUptime() (float64, error) {
	line, err := readProc("/proc/uptime")
	if err != nil {
		return 0, err
	}
	fields := strings.Fields(line)
	if len(fields) < 1 {
		return 0, fmt.Errorf("unexpected /proc/uptime format")
	}
	return strconv.ParseFloat(fields[0], 64)
}

// readProcessStat 读取本进程 /proc/self/stat
func readProcessStat() (utime, stime, starttime float64, rssPages uint64, err error) {
	return readProcessStatByPID(os.Getpid())
}

// readProcessStatByPID 读取指定 PID 的 /proc/[pid]/stat
// 返回 utime, stime, starttime (jiffies), rssPages
func readProcessStatByPID(pid int) (utime, stime, starttime float64, rssPages uint64, err error) {
	line, err := readProc(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return 0, 0, 0, 0, err
	}
	// 进程名可能含括号/空格，用最后一个 ')' 分隔
	idx := strings.LastIndex(line, ")")
	if idx < 0 {
		return 0, 0, 0, 0, fmt.Errorf("unexpected /proc/%d/stat format", pid)
	}
	fields := strings.Fields(line[idx+2:]) // 跳过 ") "
	if len(fields) < 20 {
		return 0, 0, 0, 0, fmt.Errorf("too few fields in /proc/%d/stat", pid)
	}
	utime, _ = strconv.ParseFloat(fields[11], 64)       // utime — field 13 (0-indexed: 11)
	stime, _ = strconv.ParseFloat(fields[12], 64)       // stime — field 14 (0-indexed: 12)
	starttime, _ = strconv.ParseFloat(fields[19], 64)   // starttime — field 21 (0-indexed: 19)
	rssPages, _ = strconv.ParseUint(fields[21], 10, 64) // rss — field 24 (0-indexed: 21)
	return
}

// readProcessComm 读取进程的 comm（内核短名，截断到 15 字节）
func readProcessComm(pid int) string {
	raw, err := readProc(fmt.Sprintf("/proc/%d/comm", pid))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(raw)
}

// readProcessCmdline 读取进程的命令行，返回可执行文件基名
func readProcessDisplayName(pid int) string {
	raw, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", pid))
	if err != nil {
		// fallback to comm
		return readProcessComm(pid)
	}
	parts := strings.Split(string(raw), "\x00")
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			base := filepath.Base(p)
			// 忽略 shell 解释器（如 /bin/sh /usr/bin/node 才是真正的进程）
			if base != "sh" && base != "bash" && !strings.HasPrefix(base, "ld-") {
				return base
			}
		}
	}
	// fallback: 用最后一个非空段
	for i := len(parts) - 1; i >= 0; i-- {
		p := strings.TrimSpace(parts[i])
		if p != "" {
			if b := filepath.Base(p); b != "" {
				return b
			}
		}
	}
	return readProcessComm(pid)
}

// ─── 进程发现 ────────────────────────────────────────────────────────────────

var knownProcessPrefixes = []string{"splayer-", "subsonic-"}

// isKnownProcess 判断是否为 SPlayer 体系内的进程
func isKnownProcess(comm string) bool {
	if comm == "node" || comm == "nodejs" {
		return true
	}
	for _, p := range knownProcessPrefixes {
		if strings.HasPrefix(comm, p) {
			return true
		}
	}
	return false
}

// scanSplayerProcesses 遍历 /proc，收集所有已知 SPlayer 进程信息
// 返回 map[PID] 进程快照（使用 /proc/[pid]/stat 的原始字段）
type procSnapshot struct {
	utime     float64
	stime     float64
	starttime float64
	rssPages  uint64
	comm      string
	display   string
}

func scanSplayerProcesses() map[int]procSnapshot {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return nil
	}

	out := make(map[int]procSnapshot)
	for _, e := range entries {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		comm := readProcessComm(pid)
		if comm == "" || !isKnownProcess(comm) {
			continue
		}

		utime, stime, starttime, rssPages, err := readProcessStatByPID(pid)
		if err != nil {
			continue
		}

		out[pid] = procSnapshot{
			utime:     utime,
			stime:     stime,
			starttime: starttime,
			rssPages:  rssPages,
			comm:      comm,
			display:   readProcessDisplayName(pid),
		}
	}
	return out
}

// ─── Cgroup (v2) 读取 ────────────────────────────────────────────────────────

// ─── cgroup 路径（运行时动态检测，兼容容器 / 宿主机） ───

const cgroupRoot = "/sys/fs/cgroup"

var (
	cgroupV2        bool
	cgroupV2Base    string // v2 子路径，如 /system.slice/docker-xxx.scope
	cgroupV1MemBase string // v1 memory 子系统子路径
)

func initCgroupPaths() {
	// 优先：cgroup v2 检测
	if _, err := os.Stat(filepath.Join(cgroupRoot, "cgroup.controllers")); err == nil {
		cgroupV2 = true
		cgroupV2Base = resolveCgroupPath("0::")
		return
	}

	// cgroup v1：从 /proc/self/cgroup 解析 per-subsystem 路径
	cgroupV1MemBase = resolveCgroupPath("memory:")
}

// resolveCgroupPath 从 /proc/self/cgroup 中提取匹配 prefix 的 cgroup 路径
// prefix 示例：v2="0::", v1="memory:"
func resolveCgroupPath(prefix string) string {
	raw, err := readProc("/proc/self/cgroup")
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(raw, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if strings.HasPrefix(line, prefix) {
			// v2: "0::/path" → fields = ["0","","/path"]
			// v1: "12:memory:/path" → fields = ["12","memory","/path"]
			fields := strings.SplitN(line, ":", 3)
			if len(fields) == 3 && fields[2] != "" && fields[2] != "/" {
				return fields[2]
			}
		}
	}
	return ""
}

// cgPath 拼接 cgroup 路径。base 为空时直接用 cgroupRoot/path
func cgPath(base, path string) string {
	if base != "" {
		return filepath.Join(cgroupRoot, base, path)
	}
	// Docker 容器内 cgroup 挂载在根，直接拼接即可
	if _, err := os.Stat(filepath.Join(cgroupRoot, path)); err == nil {
		return filepath.Join(cgroupRoot, path)
	}
	// 容器外场景：尝试 cgroupRoot/path 并 fallback
	return filepath.Join(cgroupRoot, path)
}

// readCgroupMem reads a cgroup memory file, returns 0 if not available
func readCgroupMem(path string) uint64 {
	raw, err := readProc(path)
	if err != nil {
		return 0
	}
	if raw == "max" {
		return 0
	}
	fields := strings.Fields(raw)
	if len(fields) == 0 {
		return 0
	}
	v, err := strconv.ParseUint(fields[0], 10, 64)
	if err != nil {
		return 0
	}
	return v
}

// readCgroupContainerStats reads container-level CPU/memory from cgroup (v1 or v2)
func readCgroupContainerStats() (cpuUser, cpuSystem uint64, cpuCores float64, memUsed, memLimit uint64) {
	if cgroupV2 {
		// cpu.max: "MAX PERIOD" (quota in µs, period in µs)
		raw, err := readProc(cgPath(cgroupV2Base, "cpu.max"))
		if err == nil {
			fields := strings.Fields(raw)
			if len(fields) >= 2 && fields[0] != "max" {
				quota, _ := strconv.ParseUint(fields[0], 10, 64)
				period, _ := strconv.ParseUint(fields[1], 10, 64)
				if quota > 0 && period > 0 {
					cpuCores = float64(quota) / float64(period)
				}
			}
		}
		// cpu.stat
		if statRaw, err := readProc(cgPath(cgroupV2Base, "cpu.stat")); err == nil {
			for _, line := range strings.Split(statRaw, "\n") {
				if strings.HasPrefix(line, "user_usec") {
					fmt.Sscanf(line, "user_usec %d", &cpuUser)
				} else if strings.HasPrefix(line, "system_usec") {
					fmt.Sscanf(line, "system_usec %d", &cpuSystem)
				}
			}
		}
		memUsed = readCgroupMem(cgPath(cgroupV2Base, "memory.current"))
		memLimit = readCgroupMem(cgPath(cgroupV2Base, "memory.max"))
		return
	}

	// cgroup v1
	if quotaRaw, err := readProc(cgPath(cgroupV1MemBase, "../cpu/cpu.cfs_quota_us")); err == nil {
		quota, _ := strconv.ParseInt(strings.TrimSpace(quotaRaw), 10, 64)
		periodRaw, _ := readProc(cgPath(cgroupV1MemBase, "../cpu/cpu.cfs_period_us"))
		period, _ := strconv.ParseUint(strings.TrimSpace(periodRaw), 10, 64)
		if quota > 0 && period > 0 {
			cpuCores = float64(quota) / float64(period)
		}
	}
	memLimit = readCgroupMem(cgPath(cgroupV1MemBase, "memory.limit_in_bytes"))
	if memLimit > 1<<50 {
		memLimit = 0
	}
	memUsed = readCgroupMem(cgPath(cgroupV1MemBase, "memory.usage_in_bytes"))
	return
}

// readCgroupUsage reads cgroup CPU usage in µs (used for delta calculation)
func readCgroupUsage() (user, system uint64) {
	if cgroupV2 {
		if raw, err := readProc(cgPath(cgroupV2Base, "cpu.stat")); err == nil {
			for _, line := range strings.Split(raw, "\n") {
				if strings.HasPrefix(line, "user_usec") {
					fmt.Sscanf(line, "user_usec %d", &user)
				} else if strings.HasPrefix(line, "system_usec") {
					fmt.Sscanf(line, "system_usec %d", &system)
				}
			}
		}
		return
	}
	// v1: cpuacct.stat in jiffies → µs (approximate: * 10000)
	if raw, err := readProc(cgPath(cgroupV1MemBase, "../cpuacct/cpuacct.stat")); err == nil {
		for _, line := range strings.Split(raw, "\n") {
			if strings.HasPrefix(line, "user") {
				var val uint64
				fmt.Sscanf(line, "user %d", &val)
				user = val * 10000
			} else if strings.HasPrefix(line, "system") {
				var val uint64
				fmt.Sscanf(line, "system %d", &val)
				system = val * 10000
			}
		}
	}
	return
}

type procJiffies struct {
	utime float64
	stime float64
}

type Collector struct {
	mu           sync.Mutex
	lastUser     float64
	lastSystem   float64
	lastIdle     float64
	lastTotal    float64
	lastCPUTime  time.Time
	processStart time.Time
	clkTck       float64

	// 容器 CPU 跟踪（cgroup 统计为微秒）
	lastCgroupCPUUser   uint64
	lastCgroupCPUSystem uint64
	lastCgroupCPUTime   time.Time

	// 进程级 CPU 跟踪
	lastProcStats map[int]procJiffies
	lastProcTime  time.Time
	collected     int // 采集次数计数器
}

func NewCollector() *Collector {
	c := &Collector{
		processStart:  time.Now(),
		clkTck:        100, // 通常 Linux 的 CLK_TCK = 100
		lastProcStats: make(map[int]procJiffies),
	}
	// 初始采样
	u, s, id, tot, err := readCPUJiffies()
	if err == nil {
		c.lastUser = u
		c.lastSystem = s
		c.lastIdle = id
		c.lastTotal = tot
		c.lastCPUTime = time.Now()
	}

	// 初始 cgroup 采样
	cgu, cgs := readCgroupUsage()
	c.lastCgroupCPUUser = cgu
	c.lastCgroupCPUSystem = cgs
	c.lastCgroupCPUTime = time.Now()
	c.lastProcTime = time.Now()

	return c
}

func (c *Collector) Collect() Stats {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	var stats Stats

	// ── 系统 CPU（host 级别） ──
	u, s, id, tot, err := readCPUJiffies()
	if err == nil && c.lastTotal > 0 {
		du := u - c.lastUser
		ds := s - c.lastSystem
		di := id - c.lastIdle
		dt := tot - c.lastTotal
		if dt > 0 {
			stats.CPU.User = du / dt * 100
			stats.CPU.System = ds / dt * 100
			stats.CPU.Idle = di / dt * 100
		}
	}
	c.lastUser, c.lastSystem, c.lastIdle, c.lastTotal = u, s, id, tot

	// ── 系统内存（host 级别） ──
	memTotal, memAvail, err := readMemInfo()
	if err == nil {
		stats.Memory.TotalMB = memTotal / 1024
		stats.Memory.AvailableMB = memAvail / 1024
		stats.Memory.UsedMB = (memTotal - memAvail) / 1024
		if memTotal > 0 {
			stats.Memory.UsedPct = float64(memTotal-memAvail) / float64(memTotal) * 100
		}
	}

	// ── 系统 uptime ──
	uptime, _ := readUptime()
	stats.Uptime = uptime

	// ── 本进程信息（Go sidecar） ──
	selfUtime, selfStime, selfStarttime, selfRssPages, err := readProcessStat()
	if err == nil {
		pUptime := uptime - selfStarttime/c.clkTck
		stats.Process = ProcessStats{
			PID:       os.Getpid(),
			CPUUser:   selfUtime / c.clkTck,
			CPUSystem: selfStime / c.clkTck,
			RSSMB:     float64(selfRssPages) * float64(4096) / 1024 / 1024,
			UptimeSec: pUptime,
		}
	}

	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	stats.Process.HeapMB = float64(m.Alloc) / 1024 / 1024

	// ── 容器级统计（cgroup） ──
	cgu, cgs := readCgroupUsage()
	_, _, cpuCores, memUsed, memLimit := readCgroupContainerStats()

	stats.Container.CPUCores = cpuCores
	stats.Container.MemoryUsedMB = memUsed / 1024 / 1024
	stats.Container.MemoryLimitMB = memLimit / 1024 / 1024

	// 容器 CPU%：相对于容器总 CPU 容量（cpuCores 个核心 = cpuCores * 100%）
	if c.lastCgroupCPUTotal() > 0 {
		du := cgu - c.lastCgroupCPUUser
		ds := cgs - c.lastCgroupCPUSystem
		dtNs := uint64(now.Sub(c.lastCgroupCPUTime).Nanoseconds())
		dtUs := dtNs / 1000
		if dtUs > 0 {
			if cpuCores > 0 {
				stats.Container.CPUUserPct = float64(du) / float64(dtUs) * 100 / cpuCores
				stats.Container.CPUSystemPct = float64(ds) / float64(dtUs) * 100 / cpuCores
			} else {
				// 无 CPU 限制时：CPU% 相对于单核（可能 >100%）
				stats.Container.CPUUserPct = float64(du) / float64(dtUs) * 100
				stats.Container.CPUSystemPct = float64(ds) / float64(dtUs) * 100
			}
		}
	}
	c.lastCgroupCPUUser = cgu
	c.lastCgroupCPUSystem = cgs
	c.lastCgroupCPUTime = now

	// 容器内存 %
	if stats.Container.MemoryLimitMB > 0 {
		stats.Container.MemoryUsedPct = float64(memUsed) / float64(memLimit) * 100
	} else {
		stats.Container.MemoryUsedPct = 0
	}

	// ── 进程级扫描 ──
	procs := scanSplayerProcesses()
	c.collected++

	// 进程 CPU% 基准：per-core 的预期 jiffies 数
	// /proc/[pid]/stat 的 utime/stime 是每核累计的 jiffies，
	// 进程 CPU% = (delta_jiffies / CLK_TCK) / dt_seconds * 100
	// 这与 top/ps 的计算方式一致（per-core 百分比）
	dtSec := float64(now.Sub(c.lastProcTime).Seconds())
	procCPUBaseline := c.clkTck * dtSec
	c.lastProcTime = now

	var procList []ProcessInfo
	for pid, snap := range procs {
		pi := ProcessInfo{
			PID:       pid,
			Name:      snap.display,
			RSSMB:     float64(snap.rssPages) * float64(4096) / 1024 / 1024,
			UptimeSec: uptime - snap.starttime/c.clkTck,
		}
		// 计算 CPU%
		if prev, ok := c.lastProcStats[pid]; ok && procCPUBaseline > 0 {
			du := snap.utime - prev.utime
			ds := snap.stime - prev.stime
			if du > 0 {
				pi.CPUUserPct = du / procCPUBaseline * 100
			}
			if ds > 0 {
				pi.CPUSysPct = ds / procCPUBaseline * 100
			}
		}
		// 更新追踪
		c.lastProcStats[pid] = procJiffies{utime: snap.utime, stime: snap.stime}
		procList = append(procList, pi)
	}

	// 清理已退出的进程
	for pid := range c.lastProcStats {
		if _, ok := procs[pid]; !ok {
			delete(c.lastProcStats, pid)
		}
	}

	stats.Processes = procList
	stats.Time = now.UnixMilli()
	return stats
}

// cgroupCPUTotal 返回容器上次采集的 CPU user+system 总和（辅助方法）
func (c *Collector) lastCgroupCPUTotal() uint64 {
	return c.lastCgroupCPUUser + c.lastCgroupCPUSystem
}

// ─── HTTP ────────────────────────────────────────────────────────────────────

type Server struct {
	collector *Collector
	logBuf    *LogBuffer
	stats     Stats
	statsMu   sync.RWMutex
	broadcast chan []byte          // SSE 广播通道
	subs      map[chan []byte]bool // SSE 订阅者
	subsMu    sync.Mutex
	interval  time.Duration // 采集间隔
}

func NewServer(collector *Collector, logBuf *LogBuffer, interval time.Duration) *Server {
	return &Server{
		collector: collector,
		logBuf:    logBuf,
		stats:     collector.Collect(),
		broadcast: make(chan []byte, 8),
		subs:      make(map[chan []byte]bool),
		interval:  interval,
	}
}

func (s *Server) updateStatsLoop() {
	for {
		stats := s.collector.Collect()
		data, err := json.Marshal(map[string]interface{}{
			"type": "stats",
			"data": stats,
		})
		s.statsMu.Lock()
		s.stats = stats
		s.statsMu.Unlock()
		if err == nil {
			s.broadcast <- data
		}

		// 每次 stats 推送同时附带最近日志，确保新连接无需等待新日志产生
		entries := s.logBuf.Tail(50)
		if entries == nil {
			entries = []LogEntry{}
		}
		if logData, err := json.Marshal(map[string]interface{}{
			"type": "logs",
			"data": entries,
		}); err == nil {
			s.broadcast <- logData
		}

		time.Sleep(s.interval)
	}
}

// broadcastLogsLoop 有新日志时广播
func (s *Server) broadcastLogsLoop() {
	ch := s.logBuf.NotifyCh()
	for range ch {
		entries := s.logBuf.Tail(20)
		if entries == nil {
			entries = []LogEntry{}
		}
		data, err := json.Marshal(map[string]interface{}{
			"type": "logs",
			"data": entries,
		})
		if err == nil {
			s.broadcast <- data
		}
	}
}

// fanoutLoop 将 broadcast 通道的消息分发给所有 SSE 订阅者
func (s *Server) fanoutLoop() {
	for msg := range s.broadcast {
		s.subsMu.Lock()
		for ch := range s.subs {
			select {
			case ch <- msg:
			default:
				// 订阅者消费太慢，跳过
			}
		}
		s.subsMu.Unlock()
	}
}

// handleStream SSE 端点：持续推送 stats + logs
func (s *Server) handleStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	ch := make(chan []byte, 32)
	s.subsMu.Lock()
	s.subs[ch] = true
	s.subsMu.Unlock()

	ctx := r.Context()
	for {
		select {
		case msg := <-ch:
			fmt.Fprintf(w, "data: %s\n\n", msg)
			flusher.Flush()
		case <-ctx.Done():
			s.subsMu.Lock()
			delete(s.subs, ch)
			s.subsMu.Unlock()
			return
		}
	}
}

func (s *Server) handleStats(w http.ResponseWriter, r *http.Request) {
	s.statsMu.RLock()
	data, _ := json.Marshal(s.stats)
	s.statsMu.RUnlock()
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleLogs(w http.ResponseWriter, r *http.Request) {
	tail := 200
	if t := r.URL.Query().Get("tail"); t != "" {
		if n, err := strconv.Atoi(t); err == nil && n > 0 && n <= 5000 {
			tail = n
		}
	}
	entries := s.logBuf.Tail(tail)
	if entries == nil {
		entries = []LogEntry{}
	}
	data, _ := json.Marshal(entries)
	w.Header().Set("Content-Type", "application/json")
	w.Write(data)
}

func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true}`))
}

// ─── 主入口 ──────────────────────────────────────────────────────────────────

func main() {
	port := "14559"
	if p := os.Getenv("MONITOR_PORT"); p != "" {
		port = p
	}

	// MONITOR_INTERVAL_MS: SSE 推送间隔（200-3000ms，默认 2000）
	intervalMs := 2000
	if v := os.Getenv("MONITOR_INTERVAL_MS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 200 && n <= 3000 {
			intervalMs = n
		}
	}
	interval := time.Duration(intervalMs) * time.Millisecond

	// 必须在任何 cgroup 读取之前调用，动态检测容器 cgroup 路径
	initCgroupPaths()

	logBuf := NewLogBuffer(2000)
	collector := NewCollector()

	// 异步读取 stdin（日志输入）
	go func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 65536), 65536)
		for scanner.Scan() {
			line := scanner.Text()
			logBuf.Write(line)
		}
		if err := scanner.Err(); err != nil {
			fmt.Fprintf(os.Stderr, "[monitor] stdin read error: %v\n", err)
		}
	}()

	srv := NewServer(collector, logBuf, interval)

	// 启动定时采集 + SSE 广播
	go srv.updateStatsLoop()
	go srv.broadcastLogsLoop()
	go srv.fanoutLoop()

	// 注册路由
	mux := http.NewServeMux()
	mux.HandleFunc("/health", srv.handleHealth)
	mux.HandleFunc("/stats", srv.handleStats)
	mux.HandleFunc("/logs", srv.handleLogs)
	mux.HandleFunc("/stream", srv.handleStream)

	// 启动 HTTP
	addr := "127.0.0.1:" + port
	fmt.Fprintf(os.Stderr, "[monitor] 启动: %s\n", addr)
	if err := http.ListenAndServe(addr, mux); err != nil {
		fmt.Fprintf(os.Stderr, "[monitor] 退出: %v\n", err)
		os.Exit(1)
	}
}
