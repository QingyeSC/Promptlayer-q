const express = require('express')
const axios = require('axios')
const WebSocket = require('ws')
const router = express.Router()
const { v4: uuidv4 } = require('uuid')
const { uploadFileBuffer } = require('../lib/upload')
const verify = require('./verify')
const modelMap = require('../lib/model-map')


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
    console.error("处理消息时出错:", error.status)
    req.body.messages = []
    return next(error)
  }
}

async function getChatID(req, res) {
  try {
    const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/playground_sessions'
    const headers = { Authorization: "Bearer " + req.account.token }
    const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
    let data = {
      "id": uuidv4(),
      "name": "Not implemented",
      "prompt_blueprint": {
        "inference_client_name": null,
        "metadata": {
          "model": model_data
        },
        "prompt_template": {
          "type": "chat",
          "messages": req.body.messages,
          "tools": req.body.tools || null,
          "tool_choice": req.body.tool_choice || null,
          "input_variables": [],
          "functions": [],
          "function_call": null
        },
        "provider_base_url_name": null
      },
      "input_variables": []
    }

    for (const item in req.body) {
      if (item === "messages" || item === "model" || item === "stream") {
        continue
      } else if (model_data.parameters[item]) {
        if (item === "thinking" && req.body[item].type === "disabled") { continue }
        model_data.parameters[item] = req.body[item]
      }
    }

    data.prompt_blueprint.metadata.model = model_data
    if (model_data.parameters.max_tokens && model_data.parameters.thinking?.budget_tokens && model_data.parameters.max_tokens < model_data.parameters.thinking.budget_tokens) {
      data.prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = model_data.parameters.max_tokens
    }
    console.log("模型参数 => ", data.prompt_blueprint.metadata.model)

    const response = await axios.put(url, data, { headers })
    if (response.data.success) {
      console.log(`生成会话ID成功: ${response.data.playground_session.id}`)
      req.chatID = response.data.playground_session.id
      return response.data.playground_session.id
    } else {
      return false
    }
  } catch (error) {
    // console.error("错误:", error.response?.data)
    res.status(500).json({
      "error": {
        "message": error.message || "服务器内部错误",
        "type": "server_error",
        "param": null,
        "code": "server_error"
      }
    })
    return false
  }
}

async function sentRequest(req, res) {
  try {
    const url = 'https://api.promptlayer.com/api/dashboard/v2/workspaces/' + req.account.workspaceId + '/run_groups'
    const headers = { Authorization: "Bearer " + req.account.token }
    const model_data = modelMap[req.body.model] ? modelMap[req.body.model] : modelMap["claude-3-7-sonnet-20250219"]
    let data = {
      "id": uuidv4(),
      "playground_session_id": req.chatID,
      "shared_prompt_blueprint": {
        "inference_client_name": null,
        "metadata": {
          "model": model_data
        },
        "prompt_template": {
          "type": "chat",
          "messages": req.body.messages,
          "tools": req.body.tools || null,
          "tool_choice": req.body.tool_choice || null,
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

    for (const item in req.body) {
      if (item === "messages" || item === "model" || item === "stream") {
        continue
      } else if (model_data.parameters[item]) {
        if (item === "thinking" && req.body[item].type === "disabled") continue
        model_data.parameters[item] = req.body[item]
      }
    }
    data.shared_prompt_blueprint.metadata.model = model_data
    if (model_data.parameters.max_tokens && model_data.parameters.thinking?.budget_tokens && model_data.parameters.max_tokens < model_data.parameters.thinking.budget_tokens) {
      data.prompt_blueprint.metadata.model.parameters.thinking.budget_tokens = model_data.parameters.max_tokens
    }

    const response = await axios.post(url, data, { headers })
    if (response.data.success) {
      return response.data.run_group.individual_run_requests[0].id
    } else {
      return false
    }
  } catch (error) {
    // console.error("错误:", error.response?.data)
    res.status(500).json({
      "error": {
        "message": error.message || "服务器内部错误",
        "type": "server_error",
        "param": null,
        "code": "server_error"
      }
    })
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
        // console.error("设置响应头时出错:", error)
      }
    }

    const { access_token, clientId } = req.account
    // 生成会话ID
    await getChatID(req, res)

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
      ws.send(sendAction)
      RequestID = await sentRequest(req, res)
      setHeader()
    })

    ws.on('message', async (data) => {
      try {
        data = data.toString()
        // console.log(JSON.parse(data))
        let ContentText = JSON.parse(data)?.messages?.[0]
        let ContentData = JSON.parse(ContentText?.data)
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

          if (ThinkingLastContent === "" && TextLastContent === "") {
            output = "该模型在发送请求时遇到错误: \n1. 请检查请求参数,模型支持参数和默认参数可在/v1/models下查看\n2. 参数设置大小是否超过模型限制\n3. 模型当前官网此模型可能负载过高,可以切换别的模型尝试,这属于正常现象\n4. Anthropic系列模型的temperature的取值为0-1,请勿设置超过1的值,思考模型的 budget_tokens 不可小于 max_tokens \n5. 交流与支持群: https://t.me/nodejs_project"
            streamChunk.choices[0].delta.content = output
            res.write(`data: ${JSON.stringify(streamChunk)}\n\n`)
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
        // console.error("处理WebSocket消息出错:", err)
      }
    })

    ws.on('error', (err) => {
      // 标准OpenAI错误响应格式
      res.status(500).json({
        "error": {
          "message": err.message,
          "type": "server_error",
          "param": null,
          "code": "server_error"
        }
      })
    })

    setTimeout(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close()
        if (!res.headersSent) {
          // 标准OpenAI超时错误响应格式
          res.status(504).json({
            "error": {
              "message": "请求超时",
              "type": "timeout",
              "param": null,
              "code": "timeout_error"
            }
          })
        }
      }
    }, 300 * 1000)

  } catch (error) {
    console.error("错误:", error)
    // 标准OpenAI通用错误响应格式
    res.status(500).json({
      "error": {
        "message": error.message || "服务器内部错误",
        "type": "server_error",
        "param": null,
        "code": "server_error"
      }
    })
  }
})

module.exports = router
