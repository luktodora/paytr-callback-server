const express = require("express")
const crypto = require("crypto")
const { createClient } = require("@supabase/supabase-js")

const app = express()
const port = process.env.PORT || 3000

// Middleware
app.use(express.json())
app.use(express.urlencoded({ extended: true }))

// CORS middleware
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept, Authorization")

  if (req.method === "OPTIONS") {
    res.sendStatus(200)
  } else {
    next()
  }
})

// Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

// PayTR credentials
const PAYTR_MERCHANT_ID = process.env.PAYTR_MERCHANT_ID
const PAYTR_MERCHANT_KEY = process.env.PAYTR_MERCHANT_KEY
const PAYTR_MERCHANT_SALT = process.env.PAYTR_MERCHANT_SALT
const MAIN_SITE_URL = process.env.MAIN_SITE_URL || "https://mapsyorum.com.tr"

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "Railway PayTR Callback Server Running",
    timestamp: new Date().toISOString(),
    environment: {
      port: port,
      supabase_url: process.env.SUPABASE_URL ? "Set" : "Not Set",
      paytr_merchant_id: PAYTR_MERCHANT_ID ? "Set" : "Not Set",
      main_site_url: MAIN_SITE_URL,
    },
  })
})

// PayTR callback endpoint
app.post("/", async (req, res) => {
  try {
    console.log("🔔 PayTR Callback received:", req.body)
    console.log("📋 Headers:", req.headers)

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

    // Log the callback
    await supabase.from("payment_logs").insert({
      order_id: null,
      event: "paytr_callback_received",
      data: {
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
        timestamp: new Date().toISOString(),
        source: "railway_server",
      },
    })

    // Verify hash
    const hashStr = `${merchant_oid}${PAYTR_MERCHANT_SALT}${status}${total_amount}`
    const calculatedHash = crypto.createHmac("sha256", PAYTR_MERCHANT_KEY).update(hashStr).digest("base64")

    console.log("🔐 Hash verification:", {
      received: hash,
      calculated: calculatedHash,
      match: hash === calculatedHash,
    })

    if (hash !== calculatedHash) {
      console.error("❌ Hash verification failed")
      await supabase.from("payment_logs").insert({
        order_id: null,
        event: "hash_verification_failed",
        data: { merchant_oid, received_hash: hash, calculated_hash: calculatedHash },
      })
      return res.status(400).send("Hash verification failed")
    }

    // Find the order
    const { data: order, error: orderError } = await supabase
      .from("orders")
      .select("*")
      .eq("order_number", merchant_oid)
      .single()

    if (orderError || !order) {
      console.error("❌ Order not found:", merchant_oid)
      await supabase.from("payment_logs").insert({
        order_id: null,
        event: "order_not_found",
        data: { merchant_oid, error: orderError },
      })
      return res.status(404).send("Order not found")
    }

    console.log("✅ Order found:", order.id)

    // Update order status based on payment result
    let newStatus
    let completedAt = null

    if (status === "success") {
      newStatus = "completed"
      completedAt = new Date().toISOString()
      console.log("✅ Payment successful")
    } else {
      newStatus = "failed"
      console.log("❌ Payment failed:", failed_reason_msg)
    }

    // Update order in database
    const { error: updateError } = await supabase
      .from("orders")
      .update({
        status: newStatus,
        payment_response: req.body,
        completed_at: completedAt,
        updated_at: new Date().toISOString(),
      })
      .eq("id", order.id)

    if (updateError) {
      console.error("❌ Order update error:", updateError)
      await supabase.from("payment_logs").insert({
        order_id: order.id,
        event: "order_update_failed",
        data: { error: updateError, merchant_oid },
      })
      return res.status(500).send("Order update failed")
    }

    // Log the payment completion
    await supabase.from("payment_logs").insert({
      order_id: order.id,
      event: status === "success" ? "payment_completed" : "payment_failed",
      data: {
        merchant_oid,
        status,
        total_amount,
        failed_reason_code,
        failed_reason_msg,
        payment_type,
        currency,
        test_mode,
      },
    })

    // Notify main site about payment status
    try {
      const notificationResponse = await fetch(`${MAIN_SITE_URL}/api/payment/success-notification`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          orderNumber: merchant_oid,
          status: newStatus,
          paymentData: req.body,
        }),
      })

      console.log("📤 Main site notification sent:", notificationResponse.status)
    } catch (notifyError) {
      console.error("❌ Main site notification failed:", notifyError)
      // Don't fail the callback if notification fails
    }

    console.log("✅ Callback processed successfully")
    res.send("OK")
  } catch (error) {
    console.error("❌ Callback processing error:", error)

    // Log the error
    await supabase.from("payment_logs").insert({
      order_id: null,
      event: "callback_processing_error",
      data: {
        error: error.message,
        stack: error.stack,
        body: req.body,
      },
    })

    res.status(500).send("Internal server error")
  }
})

// Test endpoint
app.get("/test", (req, res) => {
  res.json({
    message: "Railway PayTR Callback Server Test",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
  })
})

// Start server
app.listen(port, () => {
  console.log(`🚀 Railway PayTR Callback Server running on port ${port}`)
  console.log(`📡 Callback URL: https://paytr-callback-server-production.up.railway.app/`)
  console.log(`🔗 Main Site: ${MAIN_SITE_URL}`)
})
