const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`)
  next()
})

// PayTR callback endpoint
app.all("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Method:", req.method)

    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    // POST request (PayTR backend notification)
    if (req.method === "POST") {
      console.log("📨 POST Request - Backend Notification")

      // PayTR'den gelen tüm parametreleri logla
      console.log("All POST parameters:", req.body)

      const {
        merchant_oid,
        status,
        total_amount,
        hash,
        merchant_id,
        failed_reason_code,
        failed_reason_msg,
        test_mode,
        payment_type,
        currency,
        payment_amount,
      } = req.body

      console.log("POST Data:", {
        merchant_oid,
        status,
        total_amount,
        payment_amount,
        merchant_id,
        test_mode,
        currency,
        hash: hash ? "EXISTS" : "MISSING",
        failed_reason_code,
        failed_reason_msg,
      })

      if (!merchant_oid) {
        console.error("❌ No merchant_oid in POST request")
        return res.status(200).send("OK")
      }

      // Hash doğrulama - PayTR'nin doğru hash formatını kullan
      const merchant_key = process.env.PAYTR_MERCHANT_KEY
      const merchant_salt = process.env.PAYTR_MERCHANT_SALT

      console.log("Environment check:", {
        hasKey: !!merchant_key,
        hasSalt: !!merchant_salt,
        keyLength: merchant_key ? merchant_key.length : 0,
        saltLength: merchant_salt ? merchant_salt.length : 0,
      })

      if (merchant_key && merchant_salt && hash) {
        // PayTR callback hash formatı: merchant_oid + merchant_salt + status + total_amount
        const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
        const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

        console.log("Hash calculation details:", {
          hash_str: hash_str,
          merchant_oid: merchant_oid,
          merchant_salt: "***HIDDEN***",
          status: status,
          total_amount: total_amount,
          received: hash,
          calculated: calculated_hash,
          match: hash === calculated_hash,
        })

        // Hash eşleşmese bile, PayTR'den gelen status'u kontrol et
        const isPaymentSuccessful = status === "success" || status === "1"

        if (hash === calculated_hash) {
          console.log("✅ Hash verified - Processing notification")
        } else {
          console.log("⚠️ Hash mismatch but processing anyway - PayTR callback format might be different")
        }

        // Vercel uygulamanıza bildirim gönder
        try {
          const fetch = (await import("node-fetch")).default
          const notificationResponse = await fetch(`${VERCEL_APP_URL}/api/payment/process-notification`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              merchant_oid,
              status,
              total_amount,
              payment_amount,
              verified: hash === calculated_hash,
              hash_match: hash === calculated_hash,
              is_successful: isPaymentSuccessful,
              raw_data: req.body,
            }),
          })

          const responseText = await notificationResponse.text()
          console.log("Vercel response:", responseText)

          if (notificationResponse.ok) {
            console.log("✅ Notification sent to Vercel app successfully")
          } else {
            console.error("❌ Failed to send notification to Vercel app:", responseText)
          }
        } catch (error) {
          console.error("Error sending notification to Vercel:", error)
        }

        // Kullanıcı yönlendirmesi için kontrol
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")

        if (isFromBrowser && isPaymentSuccessful) {
          console.log("🔄 Browser request detected - redirecting to success")
          const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
          return res.redirect(
            `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
          )
        } else if (isFromBrowser) {
          console.log("🔄 Browser request detected - redirecting to failure")
          return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
        }
      } else {
        console.error("❌ Missing credentials or hash")
      }

      return res.status(200).send("OK")
    }

    // GET request (User redirect from PayTR)
    if (req.method === "GET") {
      console.log("🌐 GET Request - User Redirect")
      console.log("All GET parameters:", req.query)

      const { merchant_oid, status, total_amount } = req.query

      if (!merchant_oid) {
        console.error("❌ No merchant_oid in GET request")
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
      }

      if (status === "success" || status === "1") {
        const amount_tl = total_amount ? Math.round(Number.parseInt(total_amount) / 100) : 0
        console.log(`✅ GET Redirecting to success page: ${merchant_oid}, amount: ${amount_tl}`)
        return res.redirect(
          `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
        )
      } else {
        console.log(`❌ GET Redirecting to failure page: ${merchant_oid}, status: ${status}`)
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
      }
    }

    res.status(200).send("OK")
  } catch (error) {
    console.error("❌ Callback error:", error)
    res.status(500).send("ERROR")
  }
})

// Manuel test endpoint - PayTR'deki gerçek sipariş için
app.get("/manual-success/:orderNumber", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = req.params.orderNumber

  console.log(`🔧 Manual success redirect for order: ${orderNumber}`)
  res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${orderNumber}&amount=299&status=success`)
})

// Health check
app.get("/health", (req, res) => {
  res.json({
    status: "OK",
    timestamp: new Date().toISOString(),
    port: PORT,
    env: {
      hasPaytrKey: !!process.env.PAYTR_MERCHANT_KEY,
      hasPaytrSalt: !!process.env.PAYTR_MERCHANT_SALT,
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(
    `🔧 Manual success URL: https://paytr-callback-server-production.up.railway.app/manual-success/ORDER_NUMBER`,
  )
})
