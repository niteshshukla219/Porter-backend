require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST', 'PUT'] }
});

const PORT = process.env.PORT || 5000;
const JWT_SECRET = process.env.JWT_SECRET || 'porter_super_secret_key_123';

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ limit: '10mb', extended: true }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err, client, release) => {
    if (err) {
        console.error('❌ Database connection error:', err.message);
    } else {
        console.log('✅ Database connected successfully!');
        release();
    }
});

// ==========================================
// ⚡ SOCKET.IO रियल-टाइम कनेक्शन व GPS ब्रॉडकास्ट
// ==========================================
io.on('connection', (socket) => {
    console.log('⚡ क्लाइंट कनेक्ट हुआ: ' + socket.id);

    // ड्राइवर की लाइव GPS लोकेशन ब्रॉडकास्ट
    socket.on('update_driver_location', async (data) => {
        const { bookingId, lat, lng } = data;
        // ग्राहक को उस राइड की लोकेशन पिंग करें
        io.emit(`driver_loc_${bookingId}`, { lat, lng });
        
        // डेटाबेस में लोकेशन अपडेट
        try {
            await pool.query(
                'UPDATE bookings SET driver_lat = $1, driver_lng = $2 WHERE id = $3', 
                [lat, lng, bookingId]
            );
        } catch (e) {}
    });

    socket.on('disconnect', () => {
        console.log('🔌 क्लाइंट डिस्कनेक्ट हुआ: ' + socket.id);
    });
});

app.get('/', (req, res) => {
    res.send('Porter Logistics Master API & Socket.io Server Running');
});

// ==========================================
// 1. ऑथेंटिकेशन रूट्स (AUTH - OTP)
// ==========================================
app.post('/api/auth/send-otp', async (req, res) => {
    try {
        const { phone, role } = req.body;
        if (!phone || phone.length < 10) {
            return res.status(400).json({ error: 'कृपया मान्य 10-अंकों का मोबाइल नंबर डालें!' });
        }

        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        const query = `
            INSERT INTO auth_otps (phone, otp, expires_at)
            VALUES ($1, $2, $3)
            ON CONFLICT (phone) 
            DO UPDATE SET otp = $2, expires_at = $3;
        `;
        await pool.query(query, [phone, otp, expiresAt]);

        console.log(`\n==========================================`);
        console.log(`🔑 [AUTH OTP] मोबाइल: ${phone} | रोल: ${role}`);
        console.log(`👉 OTP कोड: ${otp}`);
        console.log(`==========================================\n`);

        res.json({ message: 'OTP भेज दिया गया है', otpDebug: otp });
    } catch (err) {
        console.error('Send OTP Error:', err);
        res.status(500).json({ error: 'OTP भेजने में विफल' });
    }
});

app.post('/api/auth/verify-otp', async (req, res) => {
    try {
        const { phone, otp, role, name } = req.body;

        const otpRes = await pool.query(
            `SELECT * FROM auth_otps WHERE phone = $1 AND otp = $2 AND expires_at > NOW();`,
            [phone, otp]
        );

        if (otpRes.rows.length === 0) {
            return res.status(400).json({ error: 'गलत या एक्सपायर हो चुका OTP!' });
        }

        let userRes = await pool.query(`SELECT * FROM users WHERE phone = $1;`, [phone]);
        let user;

        if (userRes.rows.length === 0) {
            const insertRes = await pool.query(
                `INSERT INTO users (phone, role, name) VALUES ($1, $2, $3) RETURNING *;`,
                [phone, role || 'customer', name || 'User']
            );
            user = insertRes.rows[0];
        } else {
            user = userRes.rows[0];
        }

        await pool.query(`DELETE FROM auth_otps WHERE phone = $1;`, [phone]);

        const token = jwt.sign(
            { id: user.id, phone: user.phone, role: user.role },
            JWT_SECRET,
            { expiresIn: '30d' }
        );

        res.json({
            message: 'लॉगिन सफल!',
            token,
            user: { id: user.id, phone: user.phone, role: user.role, name: user.name }
        });
    } catch (err) {
        console.error('Verify OTP Error:', err);
        res.status(500).json({ error: 'लॉगिन विफल' });
    }
});

// ==========================================
// 2. कंज्यूमर बुकिंग रूट्स (CUSTOMER)
// ==========================================
app.post('/api/bookings', async (req, res) => {
    try {
        const { 
            pickup_address, drop_address, vehicle_type, fare, 
            payment_method, sender_phone, receiver_phone, 
            extra_stop, parcel_photo, driver_note 
        } = req.body;
        
        const otp = Math.floor(1000 + Math.random() * 9000).toString();

        const query = `
            INSERT INTO bookings (
                pickup_address, drop_address, vehicle_type, fare, status, current_step, otp,
                sender_phone, receiver_phone, extra_stop, parcel_photo, driver_note
            )
            VALUES ($1, $2, $3, $4, 'pending', 'pending', $5, $6, $7, $8, $9, $10)
            RETURNING *;
        `;
        const values = [
            pickup_address, drop_address, vehicle_type, fare, 
            otp, sender_phone || null, receiver_phone || null, 
            extra_stop || null, parcel_photo || null, driver_note || null
        ];
        const result = await pool.query(query, values);
        const booking = result.rows[0];
        booking.payment_method = payment_method || 'cash';

        // सॉकेट से लाइव अलर्ट भेजें
        io.emit('new_booking_alert', booking);
        io.emit('booking_status_updated', booking);

        res.status(201).json({ message: 'बुकिंग सफलतापूर्वक बन गई!', booking });
    } catch (error) {
        console.error('Booking Error:', error);
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

app.get('/api/bookings/:id/status', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const query = `SELECT id, status, current_step, vehicle_type, fare, otp FROM bookings WHERE id = $1;`;
        const result = await pool.query(query, [bookingId]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'राइड नहीं मिली' });
        res.json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// ==========================================
// 3. ड्राइवर पार्टनर रूट्स (DRIVER)
// ==========================================
app.get('/api/driver/bookings', async (req, res) => {
    try {
        const query = `SELECT * FROM bookings WHERE status IN ('pending', 'accepted') ORDER BY created_at DESC;`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// स्वीकार करना
app.put('/api/driver/bookings/:id/accept', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const query = `
            UPDATE bookings
            SET status = 'accepted', current_step = 'accepted'
            WHERE id = $1 AND status = 'pending'
            RETURNING *;
        `;
        const result = await pool.query(query, [bookingId]);
        if (result.rows.length === 0) return res.status(400).json({ error: 'यह राइड अब उपलब्ध नहीं है!' });

        const booking = result.rows[0];
        io.emit('booking_status_updated', booking);
        res.json({ message: 'राइड स्वीकार की गई!', booking });
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// स्टेप बदलना (Arrived / In-Transit)
app.put('/api/driver/bookings/:id/step', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { step, driver_name, vehicle_number } = req.body;
        
        const query = `
            UPDATE bookings
            SET current_step = $1,
                driver_name = COALESCE($2, driver_name),
                vehicle_number = COALESCE($3, vehicle_number)
            WHERE id = $4
            RETURNING *;
        `;
        const result = await pool.query(query, [step, driver_name || null, vehicle_number || null, bookingId]);
        const booking = result.rows[0];

        io.emit('booking_status_updated', booking);
        res.json({ message: 'स्टेप अपडेट हुआ', booking });
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// अस्वीकार करना
app.put('/api/driver/bookings/:id/reject', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const query = `
            UPDATE bookings
            SET status = 'cancelled', current_step = 'cancelled'
            WHERE id = $1 AND status = 'pending'
            RETURNING *;
        `;
        const result = await pool.query(query, [bookingId]);
        if (result.rows.length > 0) {
            io.emit('booking_status_updated', result.rows[0]);
        }
        res.json({ message: 'राइड अस्वीकार की गई!' });
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// OTP डालकर पूरी करना (Complete)
app.put('/api/driver/bookings/:id/complete', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { otp } = req.body;

        const checkQuery = `SELECT id, otp, status, fare FROM bookings WHERE id = $1;`;
        const checkRes = await pool.query(checkQuery, [bookingId]);

        if (checkRes.rows.length === 0) return res.status(404).json({ success: false, error: 'राइड नहीं मिली!' });

        const actualOtp = String(checkRes.rows[0].otp || '').trim();
        const enteredOtp = String(otp || '').trim();

        if (!enteredOtp || enteredOtp !== actualOtp) {
            return res.status(400).json({ success: false, error: '❌ गलत OTP! कृपया सही OTP डालें।' });
        }

        const updateQuery = `UPDATE bookings SET status = 'completed', current_step = 'completed' WHERE id = $1 RETURNING *;`;
        const result = await pool.query(updateQuery, [bookingId]);
        const booking = result.rows[0];

        io.emit('booking_status_updated', booking);

        return res.json({ success: true, message: '🎉 राइड पूरी हो गई!', booking });
    } catch (error) {
        res.status(500).json({ success: false, error: 'डेटाबेस एरर' });
    }
});

// ==========================================
// 4. एडमिन कंट्रोल रूम रूट्स (ADMIN PANEL)
// ==========================================
app.get('/api/admin/bookings', async (req, res) => {
    try {
        const query = `SELECT * FROM bookings ORDER BY created_at DESC;`;
        const result = await pool.query(query);
        res.json(result.rows);
    } catch (error) {
        console.error('Admin Fetch Error:', error);
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// एडमिन द्वारा सीधे स्टेटस बदलना
app.put('/api/admin/bookings/:id/status', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { status } = req.body;
        
        const query = `
            UPDATE bookings 
            SET status = $1, current_step = $1 
            WHERE id = $2 
            RETURNING *;
        `;
        const result = await pool.query(query, [status, bookingId]);
        const booking = result.rows[0];

        io.emit('booking_status_updated', booking);
        res.json({ message: 'एडमिन द्वारा स्टेटस अपडेट हुआ', booking });
    } catch (error) {
        res.status(500).json({ error: 'डेटाबेस एरर' });
    }
});

// ==========================================
// सर्वर स्टार्ट
// ==========================================
// ==========================================
// एडमिन द्वारा सीधे स्टेटस बदलना
// ==========================================
app.put('/api/admin/bookings/:id/status', async (req, res) => {
    try {
        const bookingId = req.params.id;
        const { status } = req.body; 
        
        // फिक्स: अगर स्टेप 'arrived' या 'in_transit' है, तो मुख्य स्टेटस 'accepted' ही रहेगा
        let mainStatus = status;
        if (status === 'arrived' || status === 'in_transit') {
            mainStatus = 'accepted';
        }
        
        const query = `
            UPDATE bookings 
            SET status = $1, current_step = $2 
            WHERE id = $3 
            RETURNING *;
        `;
        const result = await pool.query(query, [mainStatus, status, bookingId]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'राइड नहीं मिली' });
        }

        const booking = result.rows[0];
        io.emit('booking_status_updated', booking);
        res.json({ message: 'एडमिन द्वारा स्टेटस अपडेट हुआ', booking });
    } catch (error) {
        console.error('Admin Status Update Error:', error.message);
        // अब असली एरर ब्राउज़र पर जाएगा
        res.status(500).json({ error: error.message }); 
    }
});
server.listen(PORT, () => {
    console.log(`🚀 Master Server with Socket.io & Admin running on http://localhost:${PORT}`);
});