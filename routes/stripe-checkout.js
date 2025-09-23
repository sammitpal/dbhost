const router = require('express').Router();
const express = require('express');
const User = require('../models/User');
const { authenticateToken } = require('../middleware/auth');
require('dotenv').config()
const stripe = require('stripe')(process.env.STRIPE_KEY);

router.use(express.urlencoded({ extended: true }));
router.use(express.json());

// ----------------------
// Utility: simple delay
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ----------------------
// 1️⃣ Create Checkout session + draft invoice
router.post('/payment', authenticateToken, async (req, res) => {
  try {
    const { customerInfo, product_id } = req.body;
    if (!customerInfo?.address || !customerInfo?.shipping) {
      return res.status(400).json({ error: 'Customer billing and shipping addresses required.' });
    }

    // Retrieve product & price
    const product = await stripe.products.retrieve(product_id);
    const price = await stripe.prices.retrieve(product.default_price);

    // Get or create Stripe customer
    const user = await User.findById(req.user._id);
    let customerId = user?.customer_id;
    if (!customerId) {
      const customer = await stripe.customers.create({
        name: customerInfo.name,
        email: customerInfo.email,
        address: customerInfo.address,
        shipping: customerInfo.shipping
      });
      customerId = customer.id;
      await User.findByIdAndUpdate(req.user._id, { customer_id: customerId });
    }

    // --- Create draft invoice ---
    const invoice = await stripe.invoices.create({
      customer: customerId,
      auto_advance: false, // draft
      metadata: { country_of_origin: 'India' },
      auto_advance: true,
      description: `Invoice for ${product.name} (Origin: India)`
    });

    // --- Attach invoice items directly to invoice ---
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: price.unit_amount,
      currency: 'inr',
      description: `Invoice for ${product.name}`
    });

    const processingFee = Math.round(price.unit_amount * 0.03);
    await stripe.invoiceItems.create({
      customer: customerId,
      invoice: invoice.id,
      amount: processingFee,
      currency: 'inr',
      description: 'Stripe Processing Fee (3%)'
    });

    // --- Create Checkout session (payment only) ---
    const session = await stripe.checkout.sessions.create({
      customer: customerId,
      line_items: [
        { price: price.id, quantity: 1 },
        {
          price_data: {
            currency: 'inr',
            product_data: { name: 'Stripe Processing Fee (3%)' },
            unit_amount: processingFee
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      payment_intent_data: {
        metadata: { invoice_id: invoice.id } // link invoice to payment intent
      },
      success_url: `http://localhost:5173/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: 'http://localhost:5173',
      billing_address_collection: 'auto',
      shipping_address_collection: { allowed_countries: ['IN'] },
    });

    res.json({ session, invoiceId: invoice.id });
  } catch (err) {
    console.error('Payment route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 2️⃣ Finalize + manually pay invoice
router.post('/invoice', authenticateToken, async (req, res) => {
  try {
    const { session_id } = req.body;
    if (!session_id) return res.status(400).json({ error: 'session_id is required' });

    // Retrieve Checkout session with payment intent
    const session = await stripe.checkout.sessions.retrieve(session_id, { expand: ['payment_intent'] });
    const paymentIntent = session.payment_intent;

    if (!paymentIntent || paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ error: 'Payment not completed yet' });
    }

    // Retrieve invoice id from metadata
    const invoice_id = paymentIntent.metadata?.invoice_id;
    if (!invoice_id) return res.status(404).json({ error: 'Invoice ID not found in metadata' });

    const invoice = await stripe.invoices.retrieve(invoice_id);

    if (invoice.status === 'draft') {
      // Finalize invoice
      await stripe.invoices.finalizeInvoice(invoice_id);
      // Mark as paid manually
      const paidInvoice = await stripe.invoices.pay(invoice_id, { paid_out_of_band: true });
      return res.json({ invoice: paidInvoice });
    }

    // Already paid
    return res.json({ invoice });
  } catch (err) {
    console.error('Invoice route error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------
// 3️⃣ List all paid invoices for a customer
router.get('/invoices/:customerId', authenticateToken, async (req, res) => {
  try {
    const { customerId } = req.params;
    const invoices = await stripe.invoices.list({ customer: customerId, limit: 50 });
    res.json(invoices.data.filter(inv => inv.status === 'paid'));
  } catch (err) {
    console.error('Invoices list route error:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
