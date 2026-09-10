'use strict';

// 段落级"软锁"（编辑占用提示）。
//
// 锁只是协作用的提示，不参与正确性保证（真正防丢数据靠版本号 + 三方合并）。
// 生命周期：
//   1. 用户点编辑 -> acquire，成功后所有在线成员看到"谁在改"；
//   2. 编辑期间客户端定时心跳 renew，刷新最后活跃时间；
//   3. 保存/取消 -> release；
//   4. WebSocket 断开（包括关页面、崩溃）-> 该连接持有的锁立即释放；
//   5. 心跳超时（网络静默、电脑休眠）-> sweep() 按 TTL 回收。

class LockManager {
  constructor({ ttlMs = 30000, sweepIntervalMs = 5000 } = {}) {
    this.ttlMs = ttlMs;
    // nodeId -> { userId, userName, color, connId, at }
    this.locks = new Map();
    this._timer = setInterval(() => this.sweep(), sweepIntervalMs);
    this._timer.unref?.();
  }

  // 返回 null 表示成功；否则返回当前持有者（供客户端提示"正被谁编辑"）
  acquire(nodeId, user, connId) {
    const existing = this.locks.get(nodeId);
    const now = Date.now();
    if (existing) {
      if (existing.userId === user.userId) {
        existing.at = now;
        existing.connId = connId;
        return null; // 同一用户重入/重连后拿回
      }
      if (now - existing.at >= this.ttlMs) {
        // 死锁：持有者已超时，接管
        this.locks.set(nodeId, { ...user, connId, at: now });
        return null;
      }
      return existing;
    }
    this.locks.set(nodeId, { ...user, connId, at: now });
    return null;
  }

  renew(nodeId, connId) {
    const lock = this.locks.get(nodeId);
    if (!lock) return false;
    if (lock.connId !== connId) return false;
    lock.at = Date.now();
    return true;
  }

  release(nodeId, connId) {
    const lock = this.locks.get(nodeId);
    if (!lock) return false;
    if (lock.connId !== connId) return false;
    this.locks.delete(nodeId);
    return true;
  }

  // 连接关闭：释放它持有的全部锁，返回被释放的 nodeId 列表
  releaseAll(connId) {
    const released = [];
    for (const [nodeId, lock] of this.locks) {
      if (lock.connId === connId) {
        this.locks.delete(nodeId);
        released.push(nodeId);
      }
    }
    return released;
  }

  // TTL 回收，返回被回收的 nodeId 列表（服务器据此广播解锁）
  sweep() {
    const now = Date.now();
    const expired = [];
    for (const [nodeId, lock] of this.locks) {
      if (now - lock.at >= this.ttlMs) expired.push(nodeId);
    }
    for (const nodeId of expired) this.locks.delete(nodeId);
    return expired;
  }

  list() {
    const now = Date.now();
    const out = [];
    for (const [nodeId, lock] of this.locks) {
      out.push({
        nodeId,
        userId: lock.userId,
        userName: lock.userName,
        color: lock.color,
        ttlLeft: Math.max(0, this.ttlMs - (now - lock.at)),
      });
    }
    return out;
  }
}

module.exports = { LockManager };
