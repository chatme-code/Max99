export interface PacketDetails {
  clientIP: string;
  clientPort: number;
  arrivalTime: number;
  tcpTimestamp: number;
  winscale?: number;
  claimedClientType?: number;
}

export interface SuspectData {
  clientIP: string;
  clientPort: number;
  meanTcpTimestamp: number;
  meanTcpTimestampOverArrivalTime: number;
  lastAddedTo: number;
  lastWinscaleSeen?: number;
  claimedClientType?: number;
  username?: string;
}

export interface SuspectGroup {
  members: SuspectData[];
  innocentPortCount: number;
  clientIP: string;
}

export interface BotHunterStats {
  uptime: number;
  ipsCached: number;
  portsCached: number;
  packetsCached: number;
  totalSequencePairsAnalyzed: number;
  totalSequenceTransitions: number;
  sequenceSuspectPairs: number;
  ratioSuspectPairs: number;
  suspectIPsReported: number;
  suspectPortsReported: number;
  bannedIPs: number;
  bannedUsers: number;
  statsIntervalSeconds: number;
}

export interface BotHunterConfig {
  mode: string;
  sequenceAnalysis: boolean;
  ratioAnalysis: boolean;
  analyseRatiosSensitivity: number;
  minInterleaveTransitions: number;
  minAnalysisPacketsPerSocket: number;
  maxPacketsPerSocket: number;
  clientIpTimeoutSecs: number;
  clientPortTimeoutSecs: number;
  duplicateReportIntervalSecs: number;
  invalidFusionPacketThreshold: number;
  invalidFusionPacketLimitUsers: number;
  autokick: boolean;
  statsIntervalSeconds: number;
}
