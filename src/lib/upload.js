// src/lib/upload.js
const axios = require('axios')
const FormData = require('form-data')
const imageCache = require('./caches')

// 修改函数签名，接收account参数而不是从manager获取
async function uploadFileBuffer(fileBuffer, account) {
  try {
    // 检查account是否存在
    if (!account || !account.token) {
      console.error('无效的账户信息')
      return { success: false, error: '账户信息无效' }
    }
    
    const authToken = account.token
    
    // 转换为base64用于缓存检查
    const base64Data = fileBuffer.toString('base64')
    
    // 检查缓存中是否已存在此图片
    // 注意：现在每个用户都有自己的缓存空间，需要按用户区分
    const cacheKey = `${account.username || 'anonymous'}_${base64Data}`
    const cachedUrl = imageCache.getImageUrl(cacheKey)
    if (cachedUrl) {
      console.log('使用缓存的图片URL:', cachedUrl)
      return { success: true, file_url: cachedUrl }
    }
    
    // 创建表单数据
    const form = new FormData()

    // 添加文件内容到表单，使用正确的文件名和content-type
    form.append('file', fileBuffer, {
      filename: `image_${Date.now()}.png`,
      contentType: 'image/png'
    })

    // 设置请求头，添加必要的浏览器相关头信息
    const headers = {
      ...form.getHeaders(),
      'Authorization': `Bearer ${authToken}`,
      'Accept': '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
      'Origin': 'https://dashboard.promptlayer.com',
      'Referer': 'https://dashboard.promptlayer.com/',
      'Sec-Ch-Ua': '"Chromium";v="136", "Microsoft Edge";v="136", "Not.A/Brand";v="99"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'empty',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Site': 'same-site',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36 Edg/136.0.0.0',
    }

    console.log(`用户 ${account.username} 开始上传图片，大小:`, fileBuffer.length, 'bytes')

    // 发送请求
    const response = await axios.post('https://api.promptlayer.com/upload', form, { 
      headers,
      timeout: 30000 // 30秒超时
    })
    
    // 如果上传成功，添加到缓存
    if (response.data && response.data.success && response.data.file_url) {
      // 按用户区分缓存
      imageCache.addImage(cacheKey, response.data.file_url)
      console.log(`用户 ${account.username} 图片上传成功:`, response.data.file_url)
    }

    // 返回响应数据
    return response.data
  } catch (error) {
    console.error('图片上传失败:', {
      user: account?.username || 'unknown',
      status: error.response?.status,
      statusText: error.response?.statusText,
      data: error.response?.data,
      message: error.message
    })
    return { success: false, error: error.message }
  }
}

module.exports = {
  uploadFileBuffer
}