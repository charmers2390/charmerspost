const pool = require('./database');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET;

const auth = {
    // Register new user
    register: async (email, password) => {
        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const result = await pool.query(
                'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id, email',
                [email, hashedPassword]
            );
            return { success: true, user: result.rows[0] };
        } catch (error) {
            if (error.code === '23505') { // Unique violation
                return { success: false, error: 'Email already exists' };
            }
            return { success: false, error: 'Registration failed' };
        }
    },

    // Login user
    login: async (email, password) => {
        try {
            const result = await pool.query(
                'SELECT id, email, password_hash FROM users WHERE email = $1',
                [email]
            );
            
            if (result.rows.length === 0) {
                return { success: false, error: 'User not found' };
            }

            const user = result.rows[0];
            const validPassword = await bcrypt.compare(password, user.password_hash);

            if (!validPassword) {
                return { success: false, error: 'Invalid password' };
            }

            const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
            return { success: true, token, user: { id: user.id, email: user.email } };
        } catch (error) {
            return { success: false, error: 'Login failed' };
        }
    },

    // Verify JWT middleware
    verifyToken: (req, res, next) => {
        const token = req.header('Authorization')?.replace('Bearer ', '');
        
        if (!token) {
            return res.status(401).json({ error: 'Access denied. No token provided.' });
        }

        try {
            const verified = jwt.verify(token, JWT_SECRET);
            req.user = verified;
            next();
        } catch (error) {
            res.status(400).json({ error: 'Invalid token' });
        }
    }
};

module.exports = auth;
