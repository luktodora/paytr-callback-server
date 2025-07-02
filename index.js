const express = require("express")
const cors = require("cors")
const crypto = require("crypto")
const { createClient } = require("@supabase/supabase-js")

const app = express()
const PORT = process.env.PORT || 3001

// Middleware
app.use(cors())
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// Supabase client
const supabaseUrl = process.env.SUPABASE_URL
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !supabaseServiceKey) {
  console.error("❌ Missing Supabase environment variables")
  process.exit(1)
}

const supabase = createClient(supabaseUrl, supabaseServiceKey)

// PayTR configuration
const PAYTR_MERCHANT_ID = process.env.PAYTR_MERCHANT_ID
const PAYTR_MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY
const PAYTR_MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT
const MAIN_SITE_URL = process.env.MAIN_SITE_URL || "https://mapsyorum.com.tr"

if (!PAYTR_MERCHANT_ID || !PAYTR_MERCHANT_KEY || !PAYTR_MERCHANT_SALT) {
  console.error("❌ Missing PayTR environment variables")
  process.exit(1)
}

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: {
      supabaseUrl: !!supabaseUrl,
      supabaseServiceKey: !!supabaseServiceKey,
      paytrMerchantId: !!PAYTR_MERCHANT_ID,
      paytrMerchantKey: !!PAYTR_MERCHANT_KEY,
      paytrMerchantSalt: !!PAYTR_MERCHANT_SALT,
      mainSiteUrl: MAIN_SITE_URL,
    },
  })
})

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    message: "PayTR Callback Server is running",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    port: PORT,
  })
})

// PayTR callback endpoint (POST)
app.post("/", async (req, res) => {
  try {
    console.log("📥 PayTR callback received:", req.body)

    const {
      merchant_oid,
      status,
      total_amount,
      hash,
      failed_reason_code,
      failed_reason_msg,
      test_mode,
      payment_type,
      currency,
      payment_amount,
    } = req.body

    // Verify hash
    const hashStr = `${merchant_oid}${PAYTR_MERCHANT_SALT}${status}${total_amount}`
    const calculatedHash = crypto.createHmac("sha256", PAYTR_MERCHANT_KEY).update(hashStr).digest("base64")

    if (hash !== calculatedHash) {
      console.error("❌ Hash verification failed")
      return res.status(400).send("Hash verification failed")
    }

    console.log("✅ Hash verified successfully")

    // Find order by order number
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("*")
      .eq("order_number", merchant_oid)
      .single()

    if (orderError || !order) {
      console.error("❌ Order not found:", merchant_oid)
      return res.status(404).send("Order not found")
    }

    console.log("✅ Order found:", order.id)

    // Update order status based on payment status
    let orderStatus = "pending"
    let paymentStatus = "pending"

    if (status === "success") {
      orderStatus = "completed"
      paymentStatus = "paid"
      console.log("✅ Payment successful for order:", merchant_oid)
    } else {
      orderStatus = "failed"
      paymentStatus = "failed"
      console.log("❌ Payment failed for order:", merchant_oid)
    }

    // Update order
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: orderStatus,
        payment_status: paymentStatus,
        updated_at: new Date().toISOString(),
        completed_at: status === "success" ? new Date().toISOString() : null,
      })
      .eq("id", order.id)

    if (updateError) {
      console.error("❌ Order update error:", updateError)
      return res.status(500).send("Order update failed")
    }

    // Log payment callback
    await supabase.from("payment_logs").insert({
      order_number: merchant_oid,
      status,
      amount: Number.parseInt(total_amount),
      hash,
      failed_reason_code: failed_reason_code || null,
      failed_reason_msg: failed_reason_msg || null,
      test_mode: test_mode === "1",
      payment_type: payment_type || null,
      currency: currency || "TL",
      payment_amount: payment_amount ? Number.parseInt(payment_amount) : null,
      callback_data: req.body,
      created_at: new Date().toISOString(),
    })

    console.log("✅ Payment log created")

    // Notify main site (optional)
    try {
      await fetch(`${MAIN_SITE_URL}/api/payment/success-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderNumber: merchant_oid,
          status: orderStatus,
          paymentStatus: paymentStatus,
          amount: total_amount,
        }),
      })
      console.log("✅ Main site notified")
    } catch (notifyError) {
      console.error("⚠️ Failed to notify main site:", notifyError)
      // Don't fail the callback if notification fails
    }

    // Respond to PayTR
    res.send("OK")
    console.log("✅ Callback processed successfully")
  } catch (error) {
    console.error("❌ Callback processing error:", error)
    res.status(500).send("Internal server error")
  }
})

// PayTR callback endpoint (GET) - for testing
app.get("/", (req, res) => {
  res.json({
    message: "PayTR Callback Server",
    status: "ready",
    timestamp: new Date().toISOString(),
  })
})

// Start server
app.listen(PORT, () => {
  console.log(`🚀 PayTR Callback Server running on port ${PORT}`)
  console.log(`📍 Health check: http://localhost:${PORT}/health`)
  console.log(`🔍 Debug info: http://localhost:${PORT}/debug`)
})
