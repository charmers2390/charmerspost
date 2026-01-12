const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
require('dotenv').config();

const pool = require('./database');
const auth = require('./auth');

const app = express();
const PORT = process.env.PORT || 3000;
const YOUR_DOMAIN = process.env.YOUR_DOMAIN;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Stripe webhook handler (MUST come before other routes)
app.post('/webhook', express.raw({type: 'application/json'}), async (request, response) => {
    const sig = request.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(request.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Webhook error:', err.message);
        return response.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Handle successful checkout
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        
        try {
            await pool.query(
                `UPDATE orders 
                 SET status = 'paid', stripe_payment_intent_id = $1 
                 WHERE stripe_session_id = $2`,
                [session.payment_intent, session.id]
            );
            console.log(`✅ Order paid: ${session.id}`);
        } catch (error) {
            console.error('Failed to update order:', error);
        }
    }

    response.json({received: true});
});

// Regular routes (use JSON parser)
app.use(express.json());

// 1. AUTH ROUTES
app.post('/register', async (req, res) => {
    const { email, password } = req.body;
    const result = await auth.register(email, password);
    res.status(result.success ? 201 : 400).json(result);
});

app.post('/login', async (req, res) => {
    const { email, password } = req.body;
    const result = await auth.login(email, password);
    res.status(result.success ? 200 : 401).json(result);
});

// 2. CHECKOUT & PAYMENT ROUTE
app.post('/create-checkout-session', async (req, res) => {
    try {
        const { bracelet_size, shipping_method, customer_email, shipping_address } = req.body;
        
        // Price mapping (in cents)
        const prices = { small: 500, medium: 900, large: 1100, xl: 1500 };
        const shippingPrices = {
            // Domestic
            'USPS Ground Advantage': 900,
            'USPS Priority Mail': 1100,
            'USPS Priority Mail Express': 2900,
            // International
            'UPS Worldwide Expedited': 9300,
            'UPS Worldwide Express': 11900,
            'USPS Priority Mail Express International': 17800
        };

        const itemPrice = prices[bracelet_size] || 500;
        const shippingCost = shippingPrices[shipping_method] || 900;
        const totalAmount = itemPrice + shippingCost;

        // 1. Save order to database FIRST with status 'pending'
        const orderResult = await pool.query(
            `INSERT INTO orders 
             (stripe_session_id, customer_email, shipping_address, bracelet_size, 
              shipping_method, shipping_cost, item_price, total_amount, status) 
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'pending') 
             RETURNING id`,
            ['temp_' + Date.now(), customer_email, shipping_address, bracelet_size, 
             shipping_method, shippingCost, itemPrice, totalAmount]
        );

        // 2. Create Stripe Checkout Session
        const session = await stripe.checkout.sessions.create({
            line_items: [{
                price_data: {
                    currency: 'usd',
                    product_data: { name: `${bracelet_size} Bracelet` },
                    unit_amount: itemPrice,
                },
                quantity: 1,
            }],
            shipping_options: [{
                shipping_rate_data: {
                    type: 'fixed_amount',
                    fixed_amount: { amount: shippingCost, currency: 'usd' },
                    display_name: shipping_method,
                },
            }],
            customer_email: customer_email,
            metadata: {
                order_id: orderResult.rows[0].id,
                bracelet_size: bracelet_size
            },
            mode: 'payment',
            success_url: `${YOUR_DOMAIN}/success.html?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${YOUR_DOMAIN}/cancel.html`,
        });

        // 3. Update order with real Stripe session ID
        await pool.query(
            'UPDATE orders SET stripe_session_id = $1 WHERE id = $2',
            [session.id, orderResult.rows[0].id]
        );

        res.json({ url: session.url, sessionId: session.id });
    } catch (error) {
        console.error('Checkout error:', error);
        res.status(500).json({ error: 'Failed to create checkout session' });
    }
});

// 3. ADMIN ROUTES (Protected)
// Get all orders
app.get('/admin/orders', auth.verifyToken, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM orders ORDER BY created_at DESC'
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch orders' });
    }
});

// Update tracking number
app.patch('/admin/orders/:id/tracking', auth.verifyToken, async (req, res) => {
    const { id } = req.params;
    const { tracking_number } = req.body;
    
    try {
        const result = await pool.query(
            `UPDATE orders 
             SET tracking_number = $1, status = 'shipped' 
             WHERE id = $2 RETURNING *`,
            [tracking_number, id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Order not found' });
        }
        
        res.json({ success: true, order: result.rows[0] });
    } catch (error) {
        res.status(500).json({ error: 'Failed to update tracking' });
    }
});

// 4. REVIEW ROUTES
app.post('/reviews', auth.verifyToken, async (req, res) => {
    const { rating, comment } = req.body;
    const userId = req.user.id;
    
    try {
        const result = await pool.query(
            'INSERT INTO reviews (user_id, rating, comment) VALUES ($1, $2, $3) RETURNING *',
            [userId, rating, comment]
        );
        res.status(201).json(result.rows[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to submit review' });
    }
});

app.get('/reviews', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT r.*, u.email 
             FROM reviews r 
             JOIN users u ON r.user_id = u.id 
             ORDER BY r.created_at DESC`
        );
        res.json(result.rows);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch reviews' });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`🚀 Server running on port ${PORT}`);
});
