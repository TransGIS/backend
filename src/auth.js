import bcrypt from 'bcryptjs'
import { Router } from 'express'
import jwt from 'jsonwebtoken'
import { Admin, logActivity } from './models.js'

const SECRET = () => process.env.JWT_SECRET || 'transgis-dev-secret'
const publicUser = (a) => ({ id: String(a._id), username: a.username, name: a.nama, role: a.role })

export const authRouter = Router()

authRouter.post('/login', async (request, response) => {
    const { username, password } = request.body || {}
    if (!username || !password) return response.status(400).json({ ok: false, message: 'Username dan kata sandi wajib diisi.' })
    const admin = await Admin.findOne({ username: String(username).trim().toLowerCase() })
        .collation({ locale: 'en', strength: 2 }) || await Admin.findOne({ username: String(username).trim() })
    if (!admin || !(await bcrypt.compare(String(password), admin.password))) {
        return response.status(401).json({ ok: false, message: 'Username atau kata sandi salah.' })
    }
    const token = jwt.sign({ sub: String(admin._id) }, SECRET(), { expiresIn: '12h' })
    response.json({ ok: true, token, user: publicUser(admin) })
})

authRouter.post('/forgot', async (request, response) => {
    const { email } = request.body || {}
    // Selalu balas ok agar tidak membocorkan email mana yang terdaftar.
    const admin = email ? await Admin.findOne({ email: String(email).trim().toLowerCase() }) : null
    await logActivity({
        adminId: admin?._id || null,
        action: 'forgot-password',
        targetCollection: 'admins',
        targetId: admin ? String(admin._id) : null,
        changes: { email: email ? String(email).trim().toLowerCase() : null, found: Boolean(admin) },
    })
    response.json({ ok: true, message: 'Jika email terdaftar, tim admin akan menghubungi Anda untuk pengaturan ulang kata sandi.' })
})

export async function requireAuth(request, response, next) {
    const header = request.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : null
    if (!token) return response.status(401).json({ ok: false, message: 'Token tidak ditemukan. Silakan login kembali.' })
    try {
        const payload = jwt.verify(token, SECRET())
        const admin = await Admin.findById(payload.sub)
        if (!admin) return response.status(401).json({ ok: false, message: 'Akun tidak ditemukan.' })
        request.admin = admin
        next()
    } catch {
        response.status(401).json({ ok: false, message: 'Sesi kedaluwarsa. Silakan login kembali.' })
    }
}
