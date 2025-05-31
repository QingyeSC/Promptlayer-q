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
  
  // 处理temperature参数：如果大于1或小于等于0或不存在，则随机取0.8-0.9之间的值
  if (!processed.temperature || processed.temperature <= 0 || processed.temperature > 1) {
    processed.temperature = Math.round((Math.random() * 0.1 + 0.8) * 100) / 100 // 0.8-0.9之间，保留两位小数
  }
  
  // 处理top_p参数：如果大于1或小于等于0或不存在，则随机取0.8-0.9之间的值
  if (!processed.top_p || processed.top_p <= 0 || processed.top_p > 1) {
    processed.top_p = Math.round((Math.random() * 0.1 + 0.8) * 100) / 100 // 0.8-0.9之间，保留两位小数
  }
  
  // 处理max_tokens参数：如果小于8192或大于16384或不存在，则默认16384
  if (!processed.max_tokens || processed.max_tokens < 8192 || processed.max_tokens > 16384) {
    processed.max_tokens = 16384
  }
  
  return processed
}

// 错误处理工具函数
function handleError(res, error, context = '服务器内部错误') {
  console.error(`${context}:`, error)
  
  // 如果有响应状态码，使用原始状态码
  const statusCode = error.response?.status || 500
  
  // 尝试获取上游的原始错误信息
  let errorMessage = context
  let errorType = 'server_error'
  let errorCode = 'server_error'
  
  if (error.response?.data) {
    // 如果上游返回了结构化的错误信息
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
  
  // 根据状态码设置错误类型
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
                const uploadResult = await uploadFileBuffer(data)

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

async function getChatID(req, res) {
  try {
    const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/playground_sessions'
    const headers = { Authorization: "Bearer " + req.account.token }
    const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
    
    // 处理请求参数
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

    // 应用处理后的参数到模型配置
    for (const item in processedBody) {
      if (item === "messages" || item === "model" || item === "stream") {
        continue
      } else if (data.prompt_blueprint.metadata.model.parameters[item] !== undefined) {
        if (item === "thinking" && processedBody[item].type === "disabled") { continue }
        data.prompt_blueprint.metadata.model.parameters[item] = processedBody[item]
      }
    }

    // 如果模型有thinking参数，将budget_tokens设置为max_tokens的1/4
    if (data.prompt_blueprint.metadata.model.parameters.thinking && 
        data.prompt_blueprint.metadata.model.parameters.max_tokens) {
      data.prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = 
        Math.floor(data.prompt_blueprint.metadata.model.parameters.max_tokens / 4)
    }
    
    console.log("模型参数 => ", data.prompt_blueprint.metadata.model)

    const response = await axios.put(url, data, { headers })
    if (response.data.success) {
      console.log(`生成会话ID成功: ${response.data.playground_session.id}`)
      req.chatID = response.data.playground_session.id
      return response.data.playground_session.id
    } else {
      throw new Error(response.data.message || '获取会话ID失败')
    }
  } catch (error) {
    console.error("获取会话ID失败:", error)
    throw error
  }
}

async function sentRequest(req, res) {
  try {
    const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/run_groups'
    const headers = { Authorization: "Bearer " + req.account.token }
    const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
    
    // 处理请求参数
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

    // 应用处理后的参数到模型配置
    for (const item in processedBody) {
      if (item === "messages" || item === "model" || item === "stream") {
        continue
      } else if (data.shared_prompt_blueprint.metadata.model.parameters[item] !== undefined) {
        if (item === "thinking" && processedBody[item].type === "disabled") continue
        data.shared_prompt_blueprint.metadata.model.parameters[item] = processedBody[item]
      }
    }
    
    // 如果模型有thinking参数，将budget_tokens设置为max_tokens的1/4
    if (data.shared_prompt_blueprint.metadata.model.parameters.thinking && 
        data.shared_prompt_blueprint.metadata.model.parameters.max_tokens) {
      data.shared_prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = 
        Math.floor(data.shared_prompt_blueprint.metadata.model.parameters.max_tokens / 4)
    }

    const response = await axios.post(url, data, { headers })
    if (response.data.success) {
      return response.data.run_group.individual_run_requests[0].id
    } else {
      throw new Error(response.data.message || '发送请求失败')
    }
  } catch (error) {
    console.error("发送请求失败:", error)
    throw error
  }
}

// 聊天完成路由
router.post('/v1/chat/completions', verify, parseMessages, async (req, res) => {
  try {

    const setHeader = () => {
      try {
        if (req.body.stream === true) {
          res.setHeader('Content-Type', 'text/event-stream')
          res.setHeader('Cache-Control', 'no-cache')
          res.setHeader('Connection', 'keep-alive')
        } else {
          res.setHeader('Content-Type', 'application/json')
        }
      } catch (error) {
        console.error("设置响应头时出错:", error)
      }
    }

    const { access_token, clientId } = req.account
    
    // 生成会话ID
    try {
      await getChatID(req, res)
    } catch (error) {
      return handleError(res, error, '获取会话ID失败')
    }

    // 发送的数据
    const sendAction = `{"action":10,"channel":"user:${clientId}","params":{"agent":"react-hooks/2.0.2"}}`
    // 构建 WebSocket URL
    const wsUrl = `wss://realtime.ably.io/?access_token=${encodeURIComponent(access_token)}&clientId=${clientId}&format=json&heartbeats=true&v=3&agent=ably-js%2F2.0.2%20browser`
    // 创建 WebSocket 连接
    const ws = new WebSocket(wsUrl)

    // 状态详细
    let ThinkingLastContent = ""
    let TextLastContent = ""
    let ThinkingStart = false
    let ThinkingEnd = false
    let RequestID = ""
    let MessageID = "chatcmpl-" + uuidv4()
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

    ws.on('open', async () => {
      try {
        ws.send(sendAction)
        RequestID = await sentRequest(req, res)
        setHeader()
      } catch (error) {
        ws.close()
        return handleError(res, error, '发送请求失败')
      }
    })

    ws.on('message', async (data) => {
      try {
        data = data.toString()
        
        // 检查数据是否为空或无效
        if (!data || data === 'undefined' || data.trim() === '') {
          console.log('收到空或无效的WebSocket消息，跳过处理')
          return
        }
        
        let parsedData
        try {
          parsedData = JSON.parse(data)
        } catch (parseError) {
          console.log('WebSocket消息JSON解析失败，原始数据:', data)
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
          console.log('ContentText.data JSON解析失败:', ContentText.data)
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

          if (req.body.stream === true) {
            streamChunk.choices[0].delta.content = output
            res.write(`data: ${JSON.stringify(streamChunk)}\n\n`)
          }

        }
        else if (ContentText?.name === "INDIVIDUAL_RUN_COMPLETE") {

          if (req.body.stream !== true) {
            output = ThinkingLastContent ? `<think>\n\n${ThinkingLastContent}\n\n</think>\n\n${TextLastContent}` : TextLastContent
          }

          // 检查是否为空回复或错误
          if (ThinkingLastContent === "" && TextLastContent === "") {
            // 返回502错误，表示上游服务问题
            ws.close()
            return res.status(502).json({
              "error": {
                "message": "上游服务返回空响应或发生错误",
                "type": "upstream_error",
                "param": null,
                "code": "empty_response"
              }
            })
          }

          if (!req.body.stream || req.body.stream !== true) {
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

            res.json(responseJson)
            ws.close()
            return
          } else {
            // 流式响应：发送结束标记
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
          }
          ws.close()
        }

      } catch (err) {
        // 只记录非JSON解析错误
        if (!(err instanceof SyntaxError && err.message.includes('JSON'))) {
          console.error("处理WebSocket消息出错:", err)
        }
      }
    })

    ws.on('error', (err) => {
      console.error("WebSocket连接错误:", err)
      return handleError(res, err, 'WebSocket连接失败')
    })

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
        if (!res.headersSent) {
          // 返回504超时错误
          res.status(504).json({
            "error": {
              "message": "请求超时",
              "type": "timeout_error",
              "param": null,
              "code": "request_timeout"
            }
          })
        }
      }
    }, 300 * 1000)

  } catch (error) {
    console.error("聊天处理错误:", error)
    return handleError(res, error, '聊天服务错误')
  }
})

module.exports = router