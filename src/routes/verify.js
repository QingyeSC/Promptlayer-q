const manager = require('../lib/manager')

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

  const token = authorization.replace('Bearer ', '')

  if (token === process.env.AUTH_TOKEN) {
    try {
      req.account = await manager.getAccount()
      if (!req.account) {
        return res.status(503).json({ 
          error: {
            message: '服务暂时不可用，无法获取有效账户',
            type: 'service_unavailable',
            param: null,
            code: 'account_unavailable'
          }
        })
      }
      console.log(`身份校验成功，使用账号=> ${req.account.username || '匿名用户'}`)
      next()
    } catch (error) {
      console.error('获取账户时出错:', error)
      return res.status(503).json({ 
        error: {
          message: '服务暂时不可用，账户服务异常',
          type: 'service_unavailable',
          param: null,
          code: 'internal_error'
        }
      })
    }
  } else {
    return res.status(401).json({ 
      error: {
        message: '无效的API密钥',
        type: 'authentication_error',
        param: null,
        code: 'invalid_api_key'
      }
    })
  }
}

module.exports = verify