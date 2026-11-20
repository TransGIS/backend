import mongoose from 'mongoose'

let connectionPromise

export function connectDatabase() {
    if (!process.env.MONGODB_URI) return Promise.reject(new Error('MONGODB_URI belum diatur di .env'))
    if (!connectionPromise) {
        connectionPromise = mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 })
            .catch((error) => {
                connectionPromise = null
                throw error
            })
    }
    return connectionPromise
}

export const dbReady = async (_request, response, next) => {
    try {
        await connectDatabase()
        next()
    } catch (error) {
        response.status(503).json({ ok: false, message: `Koneksi MongoDB gagal: ${error.message}` })
    }
}
