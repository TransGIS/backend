import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import mongoose from 'mongoose'

dotenv.config()

const app = express()
const allowedOrigins = process.env.FRONTEND_URL
  ? process.env.FRONTEND_URL.split(',').map((origin) => origin.trim())
  : true

app.use(cors({ origin: allowedOrigins }))
app.use(express.json())

let connectionPromise

function connectDatabase() {
  if (!process.env.MONGODB_URI) return Promise.resolve(null)
  if (!connectionPromise) {
    connectionPromise = mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
    })
  }
  return connectionPromise
}

app.get('/api/health', async (_request, response) => {
  try {
    await connectDatabase()
    response.json({
      ok: true,
      message: process.env.MONGODB_URI ? 'API and MongoDB connected' : 'API connected; MongoDB URI not configured',
    })
  } catch {
    response.status(503).json({ ok: false, message: 'MongoDB connection failed' })
  }
})

app.use((_request, response) => {
  response.status(404).json({ ok: false, message: 'Route not found' })
})

export default app

if (process.env.NODE_ENV !== 'production') {
  const port = process.env.PORT || 5000
  app.listen(port, () => console.log(`API running on port ${port}`))
}
