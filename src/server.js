const express = require('express')
const modelsRoute = require('./routes/models')
const chatRoute = require('./routes/chat')
require('dotenv').config()

// 创建 Express 应用
const app = express()

// 中间件配置
app.use(express.json({ limit: "100mb" }))
app.use(express.urlencoded({ limit: "100mb", extended: true }))


// 错误处理
app.use((err, req, res, next) => {
  console.error(err.stack)
  res.status(500).send('服务器错误')
})

// 注册路由
app.use(modelsRoute)
app.use(chatRoute)

// 初始化账户系统并启动服务器
const PORT = process.env.PORT || 3000


app.listen(PORT, () => {
  console.log(`服务器运行在 http://localhost:${PORT}`)
})


module.exports = app