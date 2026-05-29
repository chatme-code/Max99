import type { SuspectData, BotHunterStats } from "./types";

class StatsCollector {
  private static instance: StatsCollector;
  private startTime: number = Date.now();
  private totalPacketProcessingMs: number = 0;
  private packetsCaptured: number = 0;
  private ipsCached: number = 0;
  private portsCached: number = 0;
  private packetsCached: number = 0;
  private totalSequencePairsAnalyzed: number = 0;
  private totalSequenceTransitions: number = 0;
  private sequenceSuspectPairs: number = 0;
  private ratioSuspectPairs: number = 0;
  private distinctClientIPs: Set<string> = new Set();
  private distinctSuspects: Set<string> = new Set();
  private statsIntervalSeconds: number = 30;

  static getInstance(): StatsCollector {
    if (!StatsCollector.instance) {
      StatsCollector.instance = new StatsCollector();
    }
    return StatsCollector.instance;
  }

  setStatsInterval(seconds: number) {
    this.statsIntervalSeconds = seconds;
  }

  updatePacketCaptureStats(
    totalMs: number,
    captured: number,
    ips: number,
    ports: number,
    packets: number
  ) {
    this.totalPacketProcessingMs = totalMs;
    this.packetsCaptured = captured;
    this.ipsCached = ips;
    this.portsCached = ports;
    this.packetsCached = packets;
  }

  addSuspects(suspects: SuspectData[]) {
    for (const s of suspects) {
      this.distinctClientIPs.add(s.clientIP);
      this.distinctSuspects.add(`${s.clientIP}:${s.clientPort}`);
    }
  }

  incrementTotalSequencePairsAnalyzed() {
    this.totalSequencePairsAnalyzed++;
  }

  incrementTotalSequenceTransitions(count: number) {
    this.totalSequenceTransitions += count;
  }

  incrementSequenceSuspectPairs() {
    this.sequenceSuspectPairs++;
  }

  incrementRatioSuspectPairs() {
    this.ratioSuspectPairs++;
  }

  getStats(bannedIPs: number, bannedUsers: number): BotHunterStats {
    return {
      uptime: Math.floor((Date.now() - this.startTime) / 1000),
      ipsCached: this.ipsCached,
      portsCached: this.portsCached,
      packetsCached: this.packetsCached,
      totalSequencePairsAnalyzed: this.totalSequencePairsAnalyzed,
      totalSequenceTransitions: this.totalSequenceTransitions,
      sequenceSuspectPairs: this.sequenceSuspectPairs,
      ratioSuspectPairs: this.ratioSuspectPairs,
      suspectIPsReported: this.distinctClientIPs.size,
      suspectPortsReported: this.distinctSuspects.size,
      bannedIPs,
      bannedUsers,
      statsIntervalSeconds: this.statsIntervalSeconds,
    };
  }

  reset() {
    this.startTime = Date.now();
    this.totalPacketProcessingMs = 0;
    this.packetsCaptured = 0;
    this.ipsCached = 0;
    this.portsCached = 0;
    this.packetsCached = 0;
    this.totalSequencePairsAnalyzed = 0;
    this.totalSequenceTransitions = 0;
    this.sequenceSuspectPairs = 0;
    this.ratioSuspectPairs = 0;
    this.distinctClientIPs.clear();
    this.distinctSuspects.clear();
  }
}

export const statsCollector = StatsCollector.getInstance();
