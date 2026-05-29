import { Params, BotHunterMode } from "./params";
import { statsCollector } from "./statsCollector";
import type { PacketDetails, SuspectData, SuspectGroup } from "./types";

interface PacketsPerSocket {
  packets: PacketDetails[];
  lastAddedTo: number;
}

interface PacketsPerIP {
  ip: string;
  sockets: Map<number, PacketsPerSocket>;
  lastSeenAt: number;
  underAnalysis: boolean;
}

export class BotHunterEngine {
  private static instance: BotHunterEngine;

  private ipBuckets: Map<string, PacketsPerIP> = new Map();
  private bannedIPs: Set<string> = new Set();
  private bannedUsers: Set<string> = new Set();
  private invalidPacketCounts: Map<string, { count: number; expiry: number }> = new Map();
  private suspectQueue: SuspectGroup[] = [];
  private lastReportedTimes: Map<string, number> = new Map();
  private usernameToIP: Map<string, string> = new Map();

  private analysisInterval: NodeJS.Timeout | null = null;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private portCounter: number = 0;

  static getInstance(): BotHunterEngine {
    if (!BotHunterEngine.instance) {
      BotHunterEngine.instance = new BotHunterEngine();
    }
    return BotHunterEngine.instance;
  }

  start() {
    if (this.analysisInterval) return;
    this.analysisInterval = setInterval(() => this.runAnalysis(), 500);
    this.cleanupInterval = setInterval(() => this.runCleanup(), 10000);
    console.log("[BotHunter] Engine started");
  }

  stop() {
    if (this.analysisInterval) clearInterval(this.analysisInterval);
    if (this.cleanupInterval) clearInterval(this.cleanupInterval);
    this.analysisInterval = null;
    this.cleanupInterval = null;
    console.log("[BotHunter] Engine stopped");
  }

  recordRequest(clientIP: string, clientPort: number, username?: string) {
    if (this.bannedIPs.has(clientIP)) return;

    const now = Date.now();
    const tcpTimestamp = process.hrtime.bigint ? Number(process.hrtime.bigint() & BigInt(0xFFFFFFFF)) : now;

    const pkt: PacketDetails = {
      clientIP,
      clientPort,
      arrivalTime: now,
      tcpTimestamp,
    };

    if (!this.ipBuckets.has(clientIP)) {
      this.ipBuckets.set(clientIP, {
        ip: clientIP,
        sockets: new Map(),
        lastSeenAt: now,
        underAnalysis: false,
      });
    }

    const ppip = this.ipBuckets.get(clientIP)!;
    ppip.lastSeenAt = now;

    if (!ppip.sockets.has(clientPort)) {
      ppip.sockets.set(clientPort, { packets: [], lastAddedTo: now });
      this.portCounter++;
    }

    const socketData = ppip.sockets.get(clientPort)!;
    socketData.packets.push(pkt);
    socketData.lastAddedTo = now;

    if (socketData.packets.length > Params.MAX_PACKETS_PER_SOCKET) {
      socketData.packets.shift();
    }

    if (username) {
      this.usernameToIP.set(username, clientIP);
    }
  }

  recordInvalidPacket(clientIP: string, clientPort: number, userCount: number = 0) {
    const key = `${clientIP}:${clientPort}`;
    const now = Date.now();

    const existing = this.invalidPacketCounts.get(key);
    if (existing && existing.expiry < now) {
      this.invalidPacketCounts.delete(key);
    }

    if (!this.invalidPacketCounts.has(key)) {
      this.invalidPacketCounts.set(key, { count: 0, expiry: now + 10 * 60 * 1000 });
    }

    const entry = this.invalidPacketCounts.get(key)!;
    entry.count++;

    console.log(`[BotHunter] Invalid packet hits=${entry.count} from ${key} threshold=${Params.INVALID_FUSION_PACKET_THRESHOLD}`);

    if (entry.count > Params.INVALID_FUSION_PACKET_THRESHOLD) {
      if (userCount <= Params.INVALID_FUSION_PACKET_LIMIT_USERS) {
        console.log(`[BotHunter] Client ${key} exceeded invalid packet threshold — banning IP`);
        this.bannedIPs.add(clientIP);
      }
    }
  }

  private runAnalysis() {
    if (this.ipBuckets.size === 0) return;

    const ips = Array.from(this.ipBuckets.keys());
    if (ips.length === 0) return;

    const key = ips[Math.floor(Math.random() * ips.length)];
    const ppip = this.ipBuckets.get(key);
    if (!ppip || ppip.underAnalysis) return;

    ppip.underAnalysis = true;
    try {
      this.findBots(ppip);
    } finally {
      ppip.underAnalysis = false;
    }
  }

  private findBots(ppip: PacketsPerIP) {
    const ip = ppip.ip;
    const sockets = Array.from(ppip.sockets.entries());
    const uniqueSuspects: Map<string, SuspectData> = new Map();

    for (let i = 0; i < sockets.length; i++) {
      for (let j = i + 1; j < sockets.length; j++) {
        const [portI, dataI] = sockets[i];
        const [portJ, dataJ] = sockets[j];

        if (this.isSocketPairSuspect(portI, portJ, dataI, dataJ)) {
          const suspectI = this.makeSuspect(ip, portI, dataI);
          const suspectJ = this.makeSuspect(ip, portJ, dataJ);
          uniqueSuspects.set(`${ip}:${portI}`, suspectI);
          uniqueSuspects.set(`${ip}:${portJ}`, suspectJ);
        }
      }
    }

    if (uniqueSuspects.size > 0) {
      const members = Array.from(uniqueSuspects.values());
      const innocentPortCount = sockets.length - members.length;

      const group: SuspectGroup = {
        members,
        innocentPortCount: Math.max(0, innocentPortCount),
        clientIP: ip,
      };

      statsCollector.addSuspects(members);
      this.reportSuspectGroup(group);
    }
  }

  private makeSuspect(ip: string, port: number, data: PacketsPerSocket): SuspectData {
    const packets = data.packets;
    let sumTimestamp = 0;
    let sumRatio = 0;

    for (const p of packets) {
      sumTimestamp += p.tcpTimestamp;
      if (p.arrivalTime > 0) {
        sumRatio += p.tcpTimestamp / p.arrivalTime;
      }
    }

    const mean = packets.length > 0 ? sumTimestamp / packets.length : 0;
    const meanRatio = packets.length > 0 ? sumRatio / packets.length : 0;

    const username = this.getUsernameForIP(ip);

    return {
      clientIP: ip,
      clientPort: port,
      meanTcpTimestamp: mean,
      meanTcpTimestampOverArrivalTime: meanRatio,
      lastAddedTo: data.lastAddedTo,
      username,
    };
  }

  private getUsernameForIP(ip: string): string | undefined {
    for (const [uname, uip] of this.usernameToIP.entries()) {
      if (uip === ip) return uname;
    }
    return undefined;
  }

  private isSocketPairSuspect(
    portI: number,
    portJ: number,
    dataI: PacketsPerSocket,
    dataJ: PacketsPerSocket
  ): boolean {
    if (dataI.packets.length < Params.MIN_ANALYSIS_PACKETS_PER_SOCKET) return false;
    if (dataJ.packets.length < Params.MIN_ANALYSIS_PACKETS_PER_SOCKET) return false;

    if (Params.SEQUENCE_ANALYSIS) {
      let ii = 0;
      let jj = 0;
      let transitionCount = 0;
      let lastArrivalDiff: number | null = null;

      while (ii < dataI.packets.length && jj < dataJ.packets.length) {
        const iPkt = dataI.packets[ii];
        const jPkt = dataJ.packets[jj];
        const arrivalDiff = jPkt.arrivalTime - iPkt.arrivalTime;
        const tsDiff = jPkt.tcpTimestamp - iPkt.tcpTimestamp;

        if (arrivalDiff * tsDiff < 0) {
          return false;
        }

        if (lastArrivalDiff !== null && arrivalDiff * lastArrivalDiff < 0) {
          transitionCount++;
        }

        if (arrivalDiff > 0) {
          ii++;
        } else {
          jj++;
        }

        lastArrivalDiff = arrivalDiff;
      }

      statsCollector.incrementTotalSequencePairsAnalyzed();
      statsCollector.incrementTotalSequenceTransitions(transitionCount);

      if (transitionCount < Params.MIN_INTERLEAVE_TRANSITIONS) {
        return false;
      }

      statsCollector.incrementSequenceSuspectPairs();
    }

    if (Params.RATIO_ANALYSIS) {
      const iMean = this.getMeanRatio(dataI.packets);
      const jMean = this.getMeanRatio(dataJ.packets);

      if (jMean === 0) return false;

      const ratioMin = 1.0 - Params.ANALYSE_RATIOS_SENSITIVITY / 100.0;
      const ratioMax = 1.0 + Params.ANALYSE_RATIOS_SENSITIVITY / 100.0;
      const ratioOfRatios = iMean / jMean;

      if (ratioOfRatios > ratioMax || ratioOfRatios < ratioMin) {
        return false;
      }

      statsCollector.incrementRatioSuspectPairs();
    }

    return true;
  }

  private getMeanRatio(packets: PacketDetails[]): number {
    if (packets.length === 0) return 0;
    let sum = 0;
    for (const p of packets) {
      if (p.arrivalTime > 0) {
        sum += p.tcpTimestamp / p.arrivalTime;
      }
    }
    return sum / packets.length;
  }

  private reportSuspectGroup(group: SuspectGroup) {
    let atLeastOneNew = false;

    for (const s of group.members) {
      const key = `${s.clientIP}:${s.clientPort}`;
      const lastTime = this.lastReportedTimes.get(key);
      const now = Date.now();

      if (!lastTime || (now - lastTime) / 1000 > Params.DUPLICATE_REPORT_INTERVAL_SECS) {
        this.lastReportedTimes.set(key, now);
        atLeastOneNew = true;
      }
    }

    if (atLeastOneNew) {
      const lines = group.members.map(s =>
        `${s.clientIP} User ${s.username ?? "<unknown>"} clientPort ${s.clientPort} meanTcpTimestamp ${s.meanTcpTimestamp.toFixed(4)} meanRatio ${s.meanTcpTimestampOverArrivalTime.toFixed(8)} lastHeardFrom/secsAgo ${Math.floor((Date.now() - s.lastAddedTo) / 1000)}`
      );

      console.log(`[BotHunter] suspectGroupIP ${group.clientIP} suspectPorts ${group.members.length} nonSuspectPorts ${group.innocentPortCount}:\n${lines.join("\n")}`);

      if (Params.AUTOKICK) {
        for (const s of group.members) {
          if (s.username) {
            this.doAutokick(s.username);
          }
        }
      }

      this.suspectQueue.push(group);
    }
  }

  private doAutokick(username: string) {
    console.log(`[BotHunter] Autokicking user ${username}`);
    this.bannedUsers.add(username);
  }

  private runCleanup() {
    const now = Date.now();
    const ipTimeout = Params.CLIENT_IP_TIMEOUT_SECS * 1000;
    const portTimeout = Params.CLIENT_PORT_TIMEOUT_SECS * 1000;

    for (const [ip, ppip] of this.ipBuckets.entries()) {
      if (ppip.underAnalysis) continue;

      if (now - ppip.lastSeenAt > ipTimeout) {
        this.ipBuckets.delete(ip);
        continue;
      }

      for (const [port, socketData] of ppip.sockets.entries()) {
        if (now - socketData.lastAddedTo > portTimeout) {
          ppip.sockets.delete(port);
          this.portCounter = Math.max(0, this.portCounter - 1);
        }
      }
    }

    const invalidExpiry = 10 * 60 * 1000;
    for (const [key, entry] of this.invalidPacketCounts.entries()) {
      if (entry.expiry < now) {
        this.invalidPacketCounts.delete(key);
      }
    }
  }

  getLatestSuspects(): SuspectGroup[] {
    const result = [...this.suspectQueue];
    this.suspectQueue = [];
    return result;
  }

  isBannedIP(ip: string): boolean {
    return this.bannedIPs.has(ip);
  }

  isBannedUser(username: string): boolean {
    return this.bannedUsers.has(username);
  }

  unbanIP(ip: string): boolean {
    return this.bannedIPs.delete(ip);
  }

  unbanUser(username: string): boolean {
    return this.bannedUsers.delete(username);
  }

  banIP(ip: string) {
    this.bannedIPs.add(ip);
  }

  banUser(username: string) {
    this.bannedUsers.add(username);
  }

  getBannedIPs(): string[] {
    return Array.from(this.bannedIPs);
  }

  getBannedUsers(): string[] {
    return Array.from(this.bannedUsers);
  }

  getStats() {
    const totalPorts = this.portCounter;
    let totalPackets = 0;
    for (const ppip of this.ipBuckets.values()) {
      for (const sock of ppip.sockets.values()) {
        totalPackets += sock.packets.length;
      }
    }

    statsCollector.updatePacketCaptureStats(
      0,
      totalPackets,
      this.ipBuckets.size,
      totalPorts,
      totalPackets
    );

    return statsCollector.getStats(this.bannedIPs.size, this.bannedUsers.size);
  }

  getConfig() {
    return {
      mode: Params.MODE,
      sequenceAnalysis: Params.SEQUENCE_ANALYSIS,
      ratioAnalysis: Params.RATIO_ANALYSIS,
      analyseRatiosSensitivity: Params.ANALYSE_RATIOS_SENSITIVITY,
      minInterleaveTransitions: Params.MIN_INTERLEAVE_TRANSITIONS,
      minAnalysisPacketsPerSocket: Params.MIN_ANALYSIS_PACKETS_PER_SOCKET,
      maxPacketsPerSocket: Params.MAX_PACKETS_PER_SOCKET,
      clientIpTimeoutSecs: Params.CLIENT_IP_TIMEOUT_SECS,
      clientPortTimeoutSecs: Params.CLIENT_PORT_TIMEOUT_SECS,
      duplicateReportIntervalSecs: Params.DUPLICATE_REPORT_INTERVAL_SECS,
      invalidFusionPacketThreshold: Params.INVALID_FUSION_PACKET_THRESHOLD,
      invalidFusionPacketLimitUsers: Params.INVALID_FUSION_PACKET_LIMIT_USERS,
      autokick: Params.AUTOKICK,
      statsIntervalSeconds: Params.STATS_INTERVAL_SECONDS,
    };
  }

  updateConfig(config: Partial<ReturnType<BotHunterEngine["getConfig"]>>) {
    if (config.mode !== undefined) Params.MODE = config.mode as BotHunterMode;
    if (config.sequenceAnalysis !== undefined) Params.SEQUENCE_ANALYSIS = config.sequenceAnalysis;
    if (config.ratioAnalysis !== undefined) Params.RATIO_ANALYSIS = config.ratioAnalysis;
    if (config.analyseRatiosSensitivity !== undefined) Params.ANALYSE_RATIOS_SENSITIVITY = config.analyseRatiosSensitivity;
    if (config.minInterleaveTransitions !== undefined) Params.MIN_INTERLEAVE_TRANSITIONS = config.minInterleaveTransitions;
    if (config.minAnalysisPacketsPerSocket !== undefined) Params.MIN_ANALYSIS_PACKETS_PER_SOCKET = config.minAnalysisPacketsPerSocket;
    if (config.maxPacketsPerSocket !== undefined) Params.MAX_PACKETS_PER_SOCKET = config.maxPacketsPerSocket;
    if (config.clientIpTimeoutSecs !== undefined) Params.CLIENT_IP_TIMEOUT_SECS = config.clientIpTimeoutSecs;
    if (config.clientPortTimeoutSecs !== undefined) Params.CLIENT_PORT_TIMEOUT_SECS = config.clientPortTimeoutSecs;
    if (config.duplicateReportIntervalSecs !== undefined) Params.DUPLICATE_REPORT_INTERVAL_SECS = config.duplicateReportIntervalSecs;
    if (config.invalidFusionPacketThreshold !== undefined) Params.INVALID_FUSION_PACKET_THRESHOLD = config.invalidFusionPacketThreshold;
    if (config.invalidFusionPacketLimitUsers !== undefined) Params.INVALID_FUSION_PACKET_LIMIT_USERS = config.invalidFusionPacketLimitUsers;
    if (config.autokick !== undefined) Params.AUTOKICK = config.autokick;
    if (config.statsIntervalSeconds !== undefined) Params.STATS_INTERVAL_SECONDS = config.statsIntervalSeconds;
  }
}

export const botHunterEngine = BotHunterEngine.getInstance();
