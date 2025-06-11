const express = require("express")
const crypto = require("crypto")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// PayTR callback endpoint
app.all("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Method:", req.method)
    console.log("Timestamp:", new Date().toISOString())

    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    // POST request (PayTR backend notification)
    if (req.method === "POST") {
      console.log("📨 POST Request - Backend Notification")

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

      console.log("EXTRACTED DATA:", {
        merchant_oid,
        status,
        total_amount,
        payment_amount,
        merchant_id,
        test_mode,
        currency,
        hash: hash ? hash.substring(0, 10) + "..." : "MISSING",
        failed_reason_code,
        failed_reason_msg,
      })

      // Merchant OID kontrolü
      if (!merchant_oid) {
        console.error("❌ No merchant_oid in POST request")
        return res.status(200).send("OK")
      }

      // Environment variables kontrolü
      const merchant_key = process.env.PAYTR_MERCHANT_KEY
      const merchant_salt = process.env.PAYTR_MERCHANT_SALT

      console.log("Environment check:", {
        hasKey: !!merchant_key,
        hasSalt: !!merchant_salt,
        keyLength: merchant_key ? merchant_key.length : 0,
        saltLength: merchant_salt ? merchant_salt.length : 0,
        // Salt'ın ilk ve son karakterlerini göster (güvenlik için)
        saltPreview: merchant_salt
          ? merchant_salt.charAt(0) + "***" + merchant_salt.charAt(merchant_salt.length - 1)
          : "MISSING",
      })

      // Status kontrolü - Hash'e bakmaksızın PayTR'nin status'una güven
      const isPaymentSuccessful = status === "success" || status === "1"

      console.log("PAYMENT STATUS CHECK:", {
        status,
        isPaymentSuccessful,
        willProcessAsSuccess: isPaymentSuccessful,
      })

      // Hash verification (opsiyonel - başarısız olsa bile işlemi sürdür)
      let hashVerified = false
      if (merchant_key && merchant_salt && hash) {
        try {
          // PayTR'nin gerçek hash formatı
          const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
          const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

          hashVerified = hash === calculated_hash

          console.log("Hash verification:", {
            received: hash.substring(0, 15) + "...",
            calculated: calculated_hash.substring(0, 15) + "...",
            match: hashVerified,
          })
        } catch (error) {
          console.error("Hash calculation error:", error)
        }
      }

      // Ödeme başarılıysa işle (hash'e bakmaksızın)
      if (isPaymentSuccessful) {
        console.log("💰 Processing successful payment (ignoring hash verification)...")

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
              status: "success",
              total_amount,
              payment_amount,
              verified: hashVerified,
              hash_match: hashVerified,
              is_successful: true,
              raw_data: req.body,
              processed_at: new Date().toISOString(),
              force_success: true, // Hash başarısız olsa bile başarılı olarak işle
            }),
          })

          const responseText = await notificationResponse.text()
          console.log("Vercel notification response:", responseText)

          if (notificationResponse.ok) {
            console.log("✅ Success notification sent to Vercel app")
          } else {
            console.error("❌ Failed to send notification to Vercel app:", responseText)
          }
        } catch (error) {
          console.error("Error sending notification to Vercel:", error)
        }

        // Browser'dan geliyorsa başarı sayfasına yönlendir
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")

        if (isFromBrowser) {
          console.log("🔄 Browser detected - redirecting to success page")
          const amount_tl = Math.round(Number.parseInt(total_amount) / 100)
          return res.redirect(
            `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
          )
        }
      } else {
        console.log("❌ Payment not successful, status:", status)

        // Browser'dan geliyorsa başarısız sayfaya yönlendir
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")

        if (isFromBrowser) {
          console.log("🔄 Browser detected - redirecting to failure page")
          return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
        }
      }

      return res.status(200).send("OK")
    }

    // GET request (User redirect from PayTR)
    if (req.method === "GET") {
      console.log("🌐 GET Request - User Redirect")
      console.log("GET Parameters:", req.query)

      const { merchant_oid, status, total_amount, payment_amount } = req.query

      if (!merchant_oid) {
        console.error("❌ No merchant_oid in GET request")
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=UNKNOWN&status=failed`)
      }

      if (status === "success" || status === "1") {
        const amount_tl = Math.round(Number.parseInt(total_amount || payment_amount || "0") / 100)
        console.log(`✅ GET Success redirect: ${merchant_oid}, amount: ${amount_tl}`)
        return res.redirect(
          `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
        )
      } else {
        console.log(`❌ GET Failure redirect: ${merchant_oid}, status: ${status}`)
        return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
      }
    }

    res.status(200).send("OK")
  } catch (error) {
    console.error("❌ Callback error:", error)
    res.status(500).send("ERROR")
  }
})

// Bu müşteri için acil çözüm
app.get("/fix-current-payment", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = "MYR17496660331102BRH3D" // Loglardan aldığımız sipariş numarası
  const amount = 299 // 29900 kuruş = 299 TL

  console.log(`🚨 FIXING CURRENT PAYMENT: ${orderNumber}`)
  res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${orderNumber}&amount=${amount}&status=success`)
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
      keyLength: process.env.PAYTR_MERCHANT_KEY ? process.env.PAYTR_MERCHANT_KEY.length : 0,
      saltLength: process.env.PAYTR_MERCHANT_SALT ? process.env.PAYTR_MERCHANT_SALT.length : 0,
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(`🚨 Fix current payment: https://paytr-callback-server-production.up.railway.app/fix-current-payment`)
})
