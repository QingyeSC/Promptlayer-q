const crypto = require('crypto')

const imageCache = new Map()

function computeHash(base64Data) {
  const base64Content = base64Data.includes('base64,') 
    ? base64Data.split('base64,')[1] 
    : base64Data
  
  return crypto.createHash('sha256')
    .update(base64Content)
    .digest('hex')
}

function hasImage(base64Data) {
  const hash = computeHash(base64Data)
  return imageCache.has(hash)
}

function getImageUrl(base64Data) {
  const hash = computeHash(base64Data)
  if (imageCache.has(hash)) {
    return imageCache.get(hash)
  }
  return null
}

function addImage(base64Data, imageUrl) {
  const hash = computeHash(base64Data)
  if (!imageCache.has(hash)) {
    imageCache.set(hash, imageUrl)
  }
}



module.exports = {
  hasImage,
  getImageUrl,
  addImage
}