const express = require("express")
const crypto = require("crypto")
const { createClient } = require("@supabase/supabase-js")

const app = express()
const PORT = process.env.PORT || 3001

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

// Environment variables check
const requiredEnvVars = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "PAYTR_MERCHANT_ID",
  "PAYTR_MERCHANT_KEY",
  "PAYTR_MERCHANT_SALT",
]

console.log("🔍 Checking environment variables...")
const missingVars = requiredEnvVars.filter((varName) => !process.env[varName])

if (missingVars.length > 0) {
  console.error("❌ Missing environment variables:", missingVars)
  process.exit(1)
}

console.log("✅ All environment variables are set")

// Initialize Supabase client
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)

console.log("✅ Supabase client initialized")

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    environment: {
      hasSupabaseUrl: !!process.env.SUPABASE_URL,
      hasSupabaseKey: !!process.env.SUPABASE_SERVICE_ROLE_KEY,
      hasPaytrCredentials: !!(
        process.env.PAYTR_MERCHANT_ID &&
        process.env.PAYTR_MERCHANT_KEY &&
        process.env.PAYTR_MERCHANT_SALT
      ),
    },
  })
})

// Debug endpoint
app.get("/debug", (req, res) => {
  res.json({
    message: "PayTR Callback Server",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || "development",
    port: PORT,
  })
})

// PayTR callback endpoint
app.post("/", async (req, res) => {
  console.log("📥 PayTR callback received:", {
    method: req.method,
    headers: req.headers,
    body: req.body,
    timestamp: new Date().toISOString(),
  })

  try {
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
    const hashString = `${merchant_oid}${process.env.PAYTR_MERCHANT_SALT}${status}${total_amount}`
    const calculatedHash = crypto
      .createHmac("sha256", process.env.PAYTR_MERCHANT_KEY)
      .update(hashString)
      .digest("base64")

    console.log("🔐 Hash verification:", {
      received: hash,
      calculated: calculatedHash,
      match: hash === calculatedHash,
    })

    if (hash !== calculatedHash) {
      console.error("❌ Hash verification failed")
      return res.status(400).send("Hash verification failed")
    }

    // Log to payment_logs table
    const logData = {
      order_number: merchant_oid,
      status: status,
      amount: Number.parseFloat(total_amount),
      hash: hash,
      failed_reason_code: failed_reason_code || null,
      failed_reason_msg: failed_reason_msg || null,
      test_mode: test_mode === "1",
      payment_type: payment_type || null,
      currency: currency || "TL",
      payment_amount: payment_amount ? Number.parseFloat(payment_amount) : null,
      callback_data: JSON.stringify(req.body),
      created_at: new Date().toISOString(),
    }

    const { error: logError } = await supabase.from("payment_logs").insert([logData])

    if (logError) {
      console.error("❌ Failed to log payment:", logError)
    } else {
      console.log("✅ Payment logged successfully")
    }

    // Update order status
    if (status === "success") {
      // Payment successful
      const { error: updateError } = await supabase
        .from("orders")
        .update({
          status: "completed",
          payment_status: "paid",
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        })
        .eq("order_number", merchant_oid)

      if (updateError) {
        console.error("❌ Failed to update order:", updateError)
      } else {
        console.log("✅ Order updated successfully")
      }
    } else {
      // Payment failed
      const { error: updateError } = await supabase
        .from("orders")
        .update({
          status: "failed",
          payment_status: "failed",
          updated_at: new Date().toISOString(),
        })
        .eq("order_number", merchant_oid)

      if (updateError) {
        console.error("❌ Failed to update failed order:", updateError)
      } else {
        console.log("✅ Failed order updated successfully")
      }
    }

    // PayTR expects "OK" response
    res.send("OK")
    console.log("✅ Callback processed successfully")
  } catch (error) {
    console.error("❌ Callback processing error:", error)
    res.status(500).send("Internal server error")
  }
})

// Handle GET requests to root
app.get("/", (req, res) => {
  res.json({
    message: "PayTR Callback Server is running",
    timestamp: new Date().toISOString(),
    endpoints: {
      callback: "POST /",
      health: "GET /health",
      debug: "GET /debug",
    },
  })
})

// Error handling middleware
app.use((error, req, res, next) => {
  console.error("❌ Unhandled error:", error)
  res.status(500).json({
    error: "Internal server error",
    timestamp: new Date().toISOString(),
  })
})

// Start server
app.listen(PORT, () => {
  console.log(`🚀 PayTR Callback Server running on port ${PORT}`)
  console.log(`📍 Health check: http://localhost:${PORT}/health`)
  console.log(`🔍 Debug info: http://localhost:${PORT}/debug`)
})
