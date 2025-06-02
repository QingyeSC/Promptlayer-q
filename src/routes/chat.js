// 优化后的聊天路由，修复流式输出问题

const express = require('express')
const axios = require('axios')
const WebSocket = require('ws')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const { uploadFileBuffer } = require('../lib/upload')
const verify = require('./verify')
const modelMap = require('../lib/model-map')

// 参数处理工具函数
function processParameters(body) {
  const processed = { ...body }
  
  if (!processed.temperature || processed.temperature <= 0 || processed.temperature > 1) {
    processed.temperature = Math.round((Math.random() * 0.1 + 0.8) * 100) / 100
  }
  
  if (!processed.top_p || processed.top_p <= 0 || processed.top_p > 1) {
    processed.top_p = Math.round((Math.random() * 0.1 + 0.8) * 100) / 100
  }
  
  if (!processed.max_tokens || processed.max_tokens < 8192 || processed.max_tokens > 16384) {
    processed.max_tokens = 16384
  }
  
  return processed
}

// 错误处理工具函数
function handleError(res, error, context = '服务器内部错误') {
  console.error(`${context}:`, error)
  
  // 如果响应头已经发送（流式模式），则不能再设置状态码
  if (res.headersSent) {
    // 对于流式响应，发送错误消息并结束流
    try {
      res.write(`data: {"error": {"message": "${context}", "type": "stream_error"}}\n\n`)
      res.write(`data: [DONE]\n\n`)
      res.end()
    } catch (writeError) {
      console.error('写入流式错误响应失败:', writeError)
      res.end()
    }
    return
  }
  
  const statusCode = error.response?.status || 500
  let errorMessage = context
  let errorType = 'server_error'
  let errorCode = 'server_error'
  
  if (error.response?.data) {
    if (error.response.data.error) {
      errorMessage = error.response.data.error.message || error.response.data.error
      errorType = error.response.data.error.type || 'upstream_error'
      errorCode = error.response.data.error.code || 'upstream_error'
    } else if (typeof error.response.data === 'string') {
      errorMessage = error.response.data
      errorType = 'upstream_error'
      errorCode = 'upstream_error'
    } else {
      errorMessage = JSON.stringify(error.response.data)
      errorType = 'upstream_error'
      errorCode = 'upstream_error'
    }
  } else if (error.message) {
    errorMessage = error.message
  }
  
  if (statusCode === 401) {
    errorType = 'authentication_error'
    errorCode = 'invalid_api_key'
  } else if (statusCode === 403) {
    errorType = 'permission_error'
    errorCode = 'forbidden'
  } else if (statusCode === 429) {
    errorType = 'rate_limit_error'
    errorCode = 'rate_limit_exceeded'
  } else if (statusCode === 503) {
    errorType = 'service_unavailable'
    errorCode = 'service_unavailable'
  }
  
  return res.status(statusCode).json({
    "error": {
      "message": errorMessage,
      "type": errorType,
      "param": null,
      "code": errorCode
    }
  })
}

// 消息解析中间件
async function parseMessages(req, res, next) {
  const messages = req.body.messages
  if (!Array.isArray(messages)) {
    req.processedMessages = []
    return next()
  }

  try {
    const transformedMessages = await Promise.all(messages.map(async (msg) => {
      const message = {
        role: msg.role,
        tool_calls: [],
        template_format: "f-string"
      }

      if (Array.isArray(msg.content)) {
        const contentItems = await Promise.all(msg.content.map(async (item) => {
          if (item.type === "text") {
            return {
              type: "text",
              text: item.text
            }
          }
          else if (item.type === "image_url") {
            try {
              const base64Match = item.image_url.url.match(/^data:image\/\w+;base64,(.+)$/)
              if (base64Match) {
                const base64 = base64Match[1]
                const data = Buffer.from(base64, 'base64')
                const uploadResult = await uploadFileBuffer(data, req.account)

                return {
                  type: "media",
                  media: {
                    "type": "image",
                    "url": uploadResult.file_url,
                    "title": `image_${Date.now()}.png`
                  }
                }
              } else {
                return {
                  type: "media",
                  media: {
                    "type": "image",
                    "url": item.image_url.url,
                    "title": "external_image"
                  }
                }
              }
            } catch (error) {
              console.error("处理图像时出错:", error)
              return {
                type: "text",
                text: "[图像处理失败]"
              }
            }
          } else {
            return {
              type: "text",
              text: JSON.stringify(item)
            }
          }
        }))

        message.content = contentItems
      } else {
        message.content = [
          {
            type: "text",
            text: msg.content || ""
          }
        ]
      }

      return message
    }))

    req.body.messages = transformedMessages
    return next()
  } catch (error) {
    console.error("处理消息时出错:", error)
    req.body.messages = []
    return next(error)
  }
}

// 获取聊天ID
async function getChatID(req, res) {
  const maxRetries = 3
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/playground_sessions'
      const headers = { Authorization: "Bearer " + req.account.access_token }
      const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
      
      const processedBody = processParameters(req.body)
      
      let data = {
        "id": uuidv4(),
        "name": "Not implemented",
        "prompt_blueprint": {
          "inference_client_name": null,
          "metadata": {
            "model": { ...model_data }
          },
          "prompt_template": {
            "type": "chat",
            "messages": processedBody.messages,
            "tools": processedBody.tools || null,
            "tool_choice": processedBody.tool_choice || null,
            "input_variables": [],
            "functions": [],
            "function_call": null
          },
          "provider_base_url_name": null
        },
        "input_variables": []
      }

      for (const item in processedBody) {
        if (item === "messages" || item === "model" || item === "stream") {
          continue
        } else if (data.prompt_blueprint.metadata.model.parameters[item] !== undefined) {
          if (item === "thinking" && processedBody[item].type === "disabled") { continue }
          data.prompt_blueprint.metadata.model.parameters[item] = processedBody[item]
        }
      }

      if (data.prompt_blueprint.metadata.model.parameters.thinking && 
          data.prompt_blueprint.metadata.model.parameters.max_tokens) {
        data.prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = 
          Math.floor(data.prompt_blueprint.metadata.model.parameters.max_tokens / 4)
      }
      
      console.log(`用户 ${req.account.username} 模型参数 =>`, data.prompt_blueprint.metadata.model)

      const response = await axios.put(url, data, { 
        headers,
        timeout: 30000
      })
      
      if (response.data.success) {
        console.log(`用户 ${req.account.username} 生成会话ID成功: ${response.data.playground_session.id}`)
        req.chatID = response.data.playground_session.id
        return response.data.playground_session.id
      } else {
        throw new Error(response.data.message || '获取会话ID失败')
      }
    } catch (error) {
      console.error(`获取会话ID失败 (尝试 ${attempt}/${maxRetries}):`, error.message)
      
      if (attempt === maxRetries) {
        throw error
      }
      
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
    }
  }
}

// 发送请求
async function sentRequest(req, res) {
  const maxRetries = 3
  
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/run_groups'
      const headers = { Authorization: "Bearer " + req.account.access_token }
      const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
      
      const processedBody = processParameters(req.body)
      
      let data = {
        "id": uuidv4(),
        "playground_session_id": req.chatID,
        "shared_prompt_blueprint": {
          "inference_client_name": null,
          "metadata": {
            "model": { ...model_data }
          },
          "prompt_template": {
            "type": "chat",
            "messages": processedBody.messages,
            "tools": processedBody.tools || null,
            "tool_choice": processedBody.tool_choice || null,
            "input_variables": [],
            "functions": [],
            "function_call": null
          },
          "provider_base_url_name": null
        },
        "individual_run_requests": [
          {
            "input_variables": {},
            "run_group_position": 1
          }
        ]
      }

      for (const item in processedBody) {
        if (item === "messages" || item === "model" || item === "stream") {
          continue
        } else if (data.shared_prompt_blueprint.metadata.model.parameters[item] !== undefined) {
          if (item === "thinking" && processedBody[item].type === "disabled") continue
          data.shared_prompt_blueprint.metadata.model.parameters[item] = processedBody[item]
        }
      }
      
      if (data.shared_prompt_blueprint.metadata.model.parameters.thinking && 
          data.shared_prompt_blueprint.metadata.model.parameters.max_tokens) {
        data.shared_prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = 
          Math.floor(data.shared_prompt_blueprint.metadata.model.parameters.max_tokens / 4)
      }

      const response = await axios.post(url, data, { 
        headers,
        timeout: 30000
      })
      
      if (response.data.success) {
        return response.data.run_group.individual_run_requests[0].id
      } else {
        throw new Error(response.data.message || '发送请求失败')
      }
    } catch (error) {
      console.error(`发送请求失败 (尝试 ${attempt}/${maxRetries}):`, error.message)
      
      if (attempt === maxRetries) {
        throw error
      }
      
      await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000))
    }
  }
}

// 创建新的WebSocket连接
function createWebSocketConnection(userAccount) {
  return new Promise((resolve, reject) => {
    const { ws_token, clientId } = userAccount
    const wsUrl = `wss://realtime.ably.io/?access_token=${encodeURIComponent(ws_token)}&clientId=${clientId}&format=json&heartbeats=true&v=3&agent=ably-js%2F2.0.2%20browser`
    
    console.log(`用户 ${userAccount.username} 创建新的WebSocket连接`)
    
    const ws = new WebSocket(wsUrl)
    const connectionId = `${clientId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
    
    ws.connectionId = connectionId
    ws.userId = clientId
    ws.createdAt = Date.now()

    ws.on('open', () => {
      console.log(`用户 ${userAccount.username} WebSocket连接已建立: ${connectionId}`)
      
      const sendAction = `{"action":10,"channel":"user:${clientId}","params":{"agent":"react-hooks/2.0.2"}}`
      ws.send(sendAction)
      
      resolve(ws)
    })

    ws.on('error', (error) => {
      console.error(`用户 ${userAccount.username} WebSocket连接错误 ${connectionId}:`, error)
      reject(error)
    })

    ws.on('close', () => {
      console.log(`用户 ${userAccount.username} WebSocket连接已关闭: ${connectionId}`)
    })

    setTimeout(() => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.close()
        reject(new Error('WebSocket连接超时'))
      }
    }, 10000)
  })
}

// 聊天完成路由 - 修复流式输出问题
router.post('/v1/chat/completions', verify, parseMessages, async (req, res) => {
  let ws = null
  const requestId = uuidv4()
  let isStreamMode = req.body.stream === true
  
  try {
    console.log(`用户 ${req.account.username} 开始处理请求: ${requestId}, 流式模式: ${isStreamMode}`)
    
    // 首先设置响应头 - 这是关键修复点
    if (isStreamMode) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
      res.setHeader('Cache-Control', 'no-cache')
      res.setHeader('Connection', 'keep-alive')
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')
      res.setHeader('X-Accel-Buffering', 'no') // 禁用 Nginx 缓冲
      
      // 立即刷新响应头
      res.flushHeaders()
    } else {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
    }

    // 创建新的WebSocket连接
    try {
      ws = await createWebSocketConnection(req.account)
    } catch (error) {
      console.error(`用户 ${req.account.username} 创建WebSocket连接失败:`, error)
      return handleError(res, error, '创建WebSocket连接失败')
    }

    // 生成会话ID
    try {
      await getChatID(req, res)
    } catch (error) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      return handleError(res, error, '获取会话ID失败')
    }

    // 状态变量
    let ThinkingLastContent = ""
    let TextLastContent = ""
    let ThinkingStart = false
    let ThinkingEnd = false
    let RequestID = ""
    let MessageID = "chatcmpl-" + uuidv4()
    let isCompleted = false
    
    let streamChunk = {
      "id": MessageID,
      "object": "chat.completion.chunk",
      "system_fingerprint": "fp_44709d6fcb",
      "created": Math.floor(Date.now() / 1000),
      "model": req.body.model,
      "choices": [
        {
          "index": 0,
          "delta": {
            "content": null
          },
          "finish_reason": null
        }
      ]
    }

    // 发送请求
    try {
      RequestID = await sentRequest(req, res)
      console.log(`用户 ${req.account.username} 发送请求成功，RequestID: ${RequestID}`)
    } catch (error) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      return handleError(res, error, '发送请求失败')
    }

    // 发送初始流式数据块（仅在流式模式下）
    if (isStreamMode) {
      try {
        const initialChunk = {
          ...streamChunk,
          choices: [{
            index: 0,
            delta: { role: "assistant" },
            finish_reason: null
          }]
        }
        res.write(`data: ${JSON.stringify(initialChunk)}\n\n`)
      } catch (writeError) {
        console.error('发送初始流式数据失败:', writeError)
      }
    }

    // 消息处理函数
    const messageHandler = async (data) => {
      try {
        data = data.toString()
        
        if (!data || data === 'undefined' || data.trim() === '') {
          return
        }
        
        let parsedData
        try {
          parsedData = JSON.parse(data)
        } catch (parseError) {
          return
        }
        
        let ContentText = parsedData?.messages?.[0]
        if (!ContentText?.data) {
          return
        }
        
        let ContentData
        try {
          ContentData = JSON.parse(ContentText.data)
        } catch (parseError) {
          return
        }
        
        const isRequestID = ContentData?.individual_run_request_id
        if (isRequestID != RequestID || !isRequestID) return

        let output = ""

        if (ContentText?.name === "UPDATE_LAST_MESSAGE") {
          const MessageArray = ContentData?.payload?.message?.content
          for (const item of MessageArray) {
            if (item.type === "text") {
              output = item.text.replace(TextLastContent, "")
              if (ThinkingStart && !ThinkingEnd) {
                ThinkingEnd = true
                output = `${output}\n\n</think>`
              }
              TextLastContent = item.text
            }
            else if (item.type === "thinking" && MessageArray.length === 1) {
              output = item.thinking.replace(ThinkingLastContent, "")
              if (!ThinkingStart) {
                ThinkingStart = true
                output = `<think>\n\n${output}`
              }
              ThinkingLastContent = item.thinking
            }
          }

          // 流式输出处理 - 关键修复点
          if (isStreamMode && output && !isCompleted) {
            try {
              streamChunk.choices[0].delta.content = output
              const chunkData = `data: ${JSON.stringify(streamChunk)}\n\n`
              res.write(chunkData)
              console.log(`用户 ${req.account.username} 发送流式数据块: ${output.length} 字符`)
            } catch (writeError) {
              console.error('写入流式数据失败:', writeError)
            }
          }
        }
        else if (ContentText?.name === "INDIVIDUAL_RUN_COMPLETE") {
          if (isCompleted) return
          isCompleted = true

          console.log(`用户 ${req.account.username} 请求完成`)

          // 检查是否为空回复或错误
          if (ThinkingLastContent === "" && TextLastContent === "") {
            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close()
            }
            
            if (isStreamMode) {
              try {
                res.write(`data: {"error": {"message": "上游服务返回空响应", "type": "upstream_error"}}\n\n`)
                res.write(`data: [DONE]\n\n`)
                res.end()
              } catch (writeError) {
                console.error('写入错误流式响应失败:', writeError)
                res.end()
              }
            } else {
              return res.status(502).json({
                "error": {
                  "message": "上游服务返回空响应或发生错误",
                  "type": "upstream_error",
                  "param": null,
                  "code": "empty_response"
                }
              })
            }
            return
          }

          if (!isStreamMode) {
            // 非流式响应
            const output = ThinkingLastContent ? `<think>\n\n${ThinkingLastContent}\n\n</think>\n\n${TextLastContent}` : TextLastContent
            
            let responseJson = {
              "id": MessageID,
              "object": "chat.completion",
              "created": Math.floor(Date.now() / 1000),
              "system_fingerprint": "fp_44709d6fcb",
              "model": req.body.model,
              "choices": [
                {
                  "index": 0,
                  "message": {
                    "role": "assistant",
                    "content": output
                  },
                  "finish_reason": "stop"
                }
              ],
              "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0
              }
            }

            if (ws && ws.readyState === WebSocket.OPEN) {
              ws.close()
            }
            
            if (!res.headersSent) {
              res.json(responseJson)
            }
            return
          } else {
            // 流式响应：发送结束标记
            try {
              let finalChunk = {
                "id": MessageID,
                "object": "chat.completion.chunk",
                "system_fingerprint": "fp_44709d6fcb",
                "created": Math.floor(Date.now() / 1000),
                "model": req.body.model,
                "choices": [
                  {
                    "index": 0,
                    "delta": {},
                    "finish_reason": "stop"
                  }
                ]
              }

              res.write(`data: ${JSON.stringify(finalChunk)}\n\n`)
              res.write(`data: [DONE]\n\n`)
              res.end()
              console.log(`用户 ${req.account.username} 流式响应已完成`)
            } catch (writeError) {
              console.error('写入最终流式数据失败:', writeError)
              res.end()
            }
          }
          
          if (ws && ws.readyState === WebSocket.OPEN) {
            ws.close()
          }
        }

      } catch (err) {
        if (!(err instanceof SyntaxError && err.message.includes('JSON'))) {
          console.error(`用户 ${req.account.username} 处理WebSocket消息出错:`, err)
        }
      }
    }

    // 错误处理函数
    const errorHandler = (error) => {
      console.error(`用户 ${req.account.username} WebSocket连接错误:`, error)
      
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close()
      }
      
      if (!res.headersSent) {
        return handleError(res, error, 'WebSocket连接失败')
      } else if (isStreamMode) {
        try {
          res.write(`data: {"error": {"message": "WebSocket连接失败", "type": "connection_error"}}\n\n`)
          res.write(`data: [DONE]\n\n`)
          res.end()
        } catch (writeError) {
          console.error('写入WebSocket错误响应失败:', writeError)
          res.end()
        }
      }
    }

    // 绑定事件监听器
    ws.on('message', messageHandler)
    ws.on('error', errorHandler)

    // 请求超时处理
    const timeout = setTimeout(() => {
      if (!isCompleted) {
        console.log(`用户 ${req.account.username} 请求超时: ${requestId}`)
        
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.close()
        }
        
        if (!res.headersSent) {
          res.status(504).json({
            "error": {
              "message": "请求超时",
              "type": "timeout_error",
              "param": null,
              "code": "request_timeout"
            }
          })
        } else if (isStreamMode) {
          try {
            res.write(`data: {"error": {"message": "请求超时", "type": "timeout_error"}}\n\n`)
            res.write(`data: [DONE]\n\n`)
            res.end()
          } catch (writeError) {
            console.error('写入超时错误响应失败:', writeError)
            res.end()
          }
        }
      }
    }, 600000) // 10分钟超时

    // 请求完成时清理超时定时器
    const originalEnd = res.end
    res.end = function(...args) {
      clearTimeout(timeout)
      originalEnd.apply(this, args)
    }

    const originalJson = res.json
    res.json = function(...args) {
      clearTimeout(timeout)
      originalJson.apply(this, args)
    }

  } catch (error) {
    console.error(`用户 ${req.account.username} 聊天处理错误:`, error)
    
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close()
    }
    
    if (!res.headersSent) {
      return handleError(res, error, '聊天服务错误')
    } else if (isStreamMode) {
      try {
        res.write(`data: {"error": {"message": "聊天服务错误", "type": "service_error"}}\n\n`)
        res.write(`data: [DONE]\n\n`)
        res.end()
      } catch (writeError) {
        console.error('写入服务错误响应失败:', writeError)
        res.end()
      }
    }
  }
})

module.exports = router