// src/lib/websocket-pool.js
// WebSocket 连接池管理器，优化高并发性能

const WebSocket = require('ws')
const { EventEmitter } = require('events')

class WebSocketPool extends EventEmitter {
  constructor(options = {}) {
    super()
    this.maxConnections = options.maxConnections || 50 // 每个用户最大连接数
    this.connectionTimeout = options.connectionTimeout || 300000 // 5分钟超时
    this.userPools = new Map() // 用户连接池 Map<userId, UserPool>
    this.cleanup()
  }

  // 获取用户的连接池
  getUserPool(userId) {
    if (!this.userPools.has(userId)) {
      this.userPools.set(userId, {
        connections: new Map(), // Map<connectionId, WebSocket>
        queue: [], // 等待中的请求队列
        activeCount: 0
      })
    }
    return this.userPools.get(userId)
  }

  // 获取或创建 WebSocket 连接
  async getConnection(userAccount, requestId) {
    const userId = userAccount.clientId
    const userPool = this.getUserPool(userId)

    // 检查是否有可用连接
    const availableConnection = this.findAvailableConnection(userPool)
    if (availableConnection) {
      console.log(`重用现有连接 for user ${userId}`)
      return availableConnection
    }

    // 检查连接数限制
    if (userPool.activeCount >= this.maxConnections) {
      console.log(`用户 ${userId} 达到最大连接数，加入队列`)
      return new Promise((resolve, reject) => {
        userPool.queue.push({ resolve, reject, userAccount, requestId })
        // 设置队列超时
        setTimeout(() => {
          const index = userPool.queue.findIndex(item => item.requestId === requestId)
          if (index !== -1) {
            userPool.queue.splice(index, 1)
            reject(new Error('连接池队列超时'))
          }
        }, 30000) // 30秒队列超时
      })
    }

    // 创建新连接
    return this.createConnection(userAccount, userPool)
  }

  // 查找可用连接
  findAvailableConnection(userPool) {
    for (const [connectionId, connection] of userPool.connections) {
      if (connection.readyState === WebSocket.OPEN && !connection.isInUse) {
        connection.isInUse = true
        connection.lastUsed = Date.now()
        return connection
      }
    }
    return null
  }

  // 创建新的 WebSocket 连接
  createConnection(userAccount, userPool) {
    return new Promise((resolve, reject) => {
      const { ws_token, clientId } = userAccount
      const wsUrl = `wss://realtime.ably.io/?access_token=${encodeURIComponent(ws_token)}&clientId=${clientId}&format=json&heartbeats=true&v=3&agent=ably-js%2F2.0.2%20browser`
      
      const ws = new WebSocket(wsUrl)
      const connectionId = `${clientId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
      
      // 连接属性
      ws.connectionId = connectionId
      ws.userId = clientId
      ws.createdAt = Date.now()
      ws.lastUsed = Date.now()
      ws.isInUse = true
      ws.requestCount = 0

      // 连接成功
      ws.on('open', () => {
        console.log(`WebSocket连接已建立: ${connectionId}`)
        userPool.connections.set(connectionId, ws)
        userPool.activeCount++
        
        // 发送初始连接消息
        const sendAction = `{"action":10,"channel":"user:${clientId}","params":{"agent":"react-hooks/2.0.2"}}`
        ws.send(sendAction)
        
        resolve(ws)
      })

      // 连接错误
      ws.on('error', (error) => {
        console.error(`WebSocket连接错误 ${connectionId}:`, error)
        this.removeConnection(connectionId, userPool)
        reject(error)
      })

      // 连接关闭
      ws.on('close', () => {
        console.log(`WebSocket连接已关闭: ${connectionId}`)
        this.removeConnection(connectionId, userPool)
      })

      // 连接超时
      setTimeout(() => {
        if (ws.readyState === WebSocket.CONNECTING) {
          ws.close()
          reject(new Error('WebSocket连接超时'))
        }
      }, 10000) // 10秒连接超时
    })
  }

  // 释放连接
  releaseConnection(ws) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.isInUse = false
      ws.lastUsed = Date.now()
      ws.requestCount++
      
      const userPool = this.getUserPool(ws.userId)
      
      // 处理队列中的请求
      if (userPool.queue.length > 0) {
        const nextRequest = userPool.queue.shift()
        ws.isInUse = true
        ws.lastUsed = Date.now()
        nextRequest.resolve(ws)
      }
      
      console.log(`连接已释放: ${ws.connectionId}, 使用次数: ${ws.requestCount}`)
    }
  }

  // 移除连接
  removeConnection(connectionId, userPool) {
    if (userPool.connections.has(connectionId)) {
      userPool.connections.delete(connectionId)
      userPool.activeCount--
    }
  }

  // 定期清理过期连接
  cleanup() {
    setInterval(() => {
      const now = Date.now()
      
      for (const [userId, userPool] of this.userPools) {
        const connectionsToRemove = []
        
        for (const [connectionId, ws] of userPool.connections) {
          // 清理条件：连接已关闭、空闲时间过长、使用次数过多
          const isExpired = (now - ws.lastUsed) > this.connectionTimeout
          const isOverused = ws.requestCount > 100 // 单个连接最多处理100个请求
          const isClosed = ws.readyState !== WebSocket.OPEN
          
          if ((isExpired || isOverused || isClosed) && !ws.isInUse) {
            connectionsToRemove.push(connectionId)
            if (ws.readyState === WebSocket.OPEN) {
              ws.close()
            }
          }
        }
        
        // 移除过期连接
        connectionsToRemove.forEach(connectionId => {
          this.removeConnection(connectionId, userPool)
        })
        
        // 清理空的用户池
        if (userPool.connections.size === 0 && userPool.queue.length === 0) {
          this.userPools.delete(userId)
        }
      }
      
      console.log(`连接池状态: ${this.userPools.size} 个用户, 总连接数: ${this.getTotalConnections()}`)
    }, 60000) // 每分钟清理一次
  }

  // 获取总连接数
  getTotalConnections() {
    let total = 0
    for (const userPool of this.userPools.values()) {
      total += userPool.connections.size
    }
    return total
  }

  // 获取统计信息
  getStats() {
    const stats = {
      totalUsers: this.userPools.size,
      totalConnections: this.getTotalConnections(),
      userStats: {}
    }
    
    for (const [userId, userPool] of this.userPools) {
      stats.userStats[userId] = {
        activeConnections: userPool.connections.size,
        queueLength: userPool.queue.length,
        activeCount: userPool.activeCount
      }
    }
    
    return stats
  }
}

// 单例模式，全局共享连接池
const globalWebSocketPool = new WebSocketPool({
  maxConnections: 10, // 每个用户最多10个并发连接
  connectionTimeout: 300000 // 5分钟空闲超时
})

module.exports = globalWebSocketPool