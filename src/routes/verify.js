// src/routes/verify.js
const axios = require('axios')

const verify = async (req, res, next) => {
  const authorization = req.headers.authorization
  if (!authorization) {
    return res.status(401).json({ 
      error: {
        message: '缺少Authorization头',
        type: 'authentication_error',
        param: null,
        code: 'missing_authorization'
      }
    })
  }

  const access_token = authorization.replace('Bearer ', '')

  try {
    // 验证用户的 PromptLayer access_token 是否有效
    const userInfo = await validatePromptLayerToken(access_token)
    if (!userInfo) {
      return res.status(401).json({ 
        error: {
          message: '无效的PromptLayer API密钥',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key'
        }
      })
    }

    // 获取用户的工作空间和WebSocket访问令牌
    const accountInfo = await getAccountInfo(access_token)
    if (!accountInfo) {
      return res.status(503).json({ 
        error: {
          message: '无法获取账户信息',
          type: 'service_unavailable',
          param: null,
          code: 'account_unavailable'
        }
      })
    }

    // 将账户信息附加到请求对象
    req.account = {
      access_token: access_token,  // 用户的官方 PromptLayer API 密钥
      ws_token: accountInfo.ws_token,  // WebSocket 临时访问令牌
      clientId: accountInfo.clientId,
      workspaceId: accountInfo.workspaceId,
      username: userInfo.email || '用户'  // 从用户信息获取邮箱
    }

    console.log(`用户 ${req.account.username} 认证成功`)
    next()
  } catch (error) {
    console.error('认证过程中出错:', error)
    
    // 根据错误类型返回适当的状态码
    if (error.response?.status === 401) {
      return res.status(401).json({ 
        error: {
          message: '无效的PromptLayer API密钥',
          type: 'authentication_error',
          param: null,
          code: 'invalid_api_key'
        }
      })
    } else if (error.response?.status === 403) {
      return res.status(403).json({ 
        error: {
          message: 'PromptLayer账户权限不足',
          type: 'permission_error',
          param: null,
          code: 'insufficient_permissions'
        }
      })
    } else {
      return res.status(503).json({ 
        error: {
          message: '服务暂时不可用，认证服务异常',
          type: 'service_unavailable',
          param: null,
          code: 'internal_error'
        }
      })
    }
  }
}

// 验证 PromptLayer access_token 有效性并获取用户信息
async function validatePromptLayerToken(access_token) {
  try {
    // 修正接口地址：从 /user 改为 /get-user
    const response = await axios.get('https://api.promptlayer.com/get-user', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      },
      timeout: 10000
    })
    
    if (response.data && response.data.success) {
      return response.data.user
    }
    return null
  } catch (error) {
    console.error('验证PromptLayer access_token失败:', error.message)
    throw error
  }
}

// 获取用户的账户信息（workspaceId、clientId等）
async function getAccountInfo(access_token) {
  try {
    // 获取 WebSocket 访问令牌和 clientId
    const wsTokenResponse = await axios.post('https://api.promptlayer.com/ws-token-request', null, {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      },
      timeout: 10000
    })

    if (!wsTokenResponse.data.success) {
      throw new Error('获取WebSocket令牌失败')
    }

    const { token: ws_token, clientId } = wsTokenResponse.data.token_details

    // 获取工作空间ID
    const workspacesResponse = await axios.get('https://api.promptlayer.com/workspaces', {
      headers: {
        'Authorization': `Bearer ${access_token}`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
      },
      timeout: 10000
    })

    if (!workspacesResponse.data.success || workspacesResponse.data.workspaces.length === 0) {
      throw new Error('获取工作空间失败')
    }

    const workspaceId = workspacesResponse.data.workspaces[0].id

    return {
      ws_token,
      clientId,
      workspaceId
    }
  } catch (error) {
    console.error('获取账户信息失败:', error.message)
    throw error
  }
}

module.exports = verify