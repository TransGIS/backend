import cors from 'cors'
import dotenv from 'dotenv'
import express from 'express'
import { pathToFileURL } from 'node:url'
import { authRouter } from './auth.js'
import { connectDatabase, dbReady } from './db.js'
import { apiRouter } from './routes.js'

dotenv.config()

const app = express()
const allowedOrigins = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map((origin) => origin.trim())
    : true

app.use(cors({ origin: allowedOrigins }))
app.use(express.json({ limit: '10mb' }))

app.get('/api/health', async (_request, response) => {
    try {
        await connectDatabase()
        response.json({ ok: true, message: 'API dan MongoDB terhubung' })
    } catch (error) {
        response.status(503).json({ ok: false, message: `MongoDB tidak terhubung: ${error.message}` })
    }
})

app.use('/api', dbReady)
app.use('/api/auth', authRouter)
app.use('/api', apiRouter)

app.use((_request, response) => {
    response.status(404).json({ ok: false, message: 'Route not found' })
})

app.use((error, _request, response, _next) => {
    if (error?.name === 'ValidationError') {
        return response.status(400).json({ ok: false, message: Object.values(error.errors).map((e) => e.message).join(', ') })
    }
    response.status(error?.status || 500).json({ ok: false, message: error?.message || 'Terjadi kesalahan di server' })
})

export default app

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isEntryPoint) {
    const port = process.env.PORT || 5000
    app.listen(port, () => console.log(`API berjalan di http://localhost:${port}`))
}
