export class PresenceManager {
  // playerId -> socket count
  private playerSockets = new Map<string, number>();

  addConnection(playerId: string): { isFirst: boolean; count: number } {
    const current = this.playerSockets.get(playerId) ?? 0;
    const next = current + 1;
    this.playerSockets.set(playerId, next);
    return { isFirst: current === 0, count: next };
  }

  removeConnection(playerId: string): { isLast: boolean; remaining: number } {
    const current = this.playerSockets.get(playerId) ?? 0;
    const next = Math.max(0, current - 1);
    if (next === 0) {
      this.playerSockets.delete(playerId);
      return { isLast: true, remaining: 0 };
    }
    this.playerSockets.set(playerId, next);
    return { isLast: false, remaining: next };
  }

  getConnectionCount(playerId: string): number {
    return this.playerSockets.get(playerId) ?? 0;
  }

  isPlayerConnected(playerId: string): boolean {
    return (this.playerSockets.get(playerId) ?? 0) > 0;
  }
}
