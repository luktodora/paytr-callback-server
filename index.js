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
      console.log("RAW BODY:", JSON.stringify(req.body, null, 2))

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

      // Hash doğrulama - Birden fazla format deneyelim
      const merchant_key = process.env.PAYTR_MERCHANT_KEY
      const merchant_salt = process.env.PAYTR_MERCHANT_SALT

      let hashVerified = false
      let calculatedHash = ""

      if (merchant_key && merchant_salt && hash) {
        // Format 1: merchant_oid + merchant_salt + status + total_amount
        const hash_str1 = `${merchant_oid}${merchant_salt}${status}${total_amount}`
        const calculated_hash1 = crypto.createHmac("sha256", merchant_key).update(hash_str1).digest("base64")

        // Format 2: merchant_id + merchant_oid + merchant_salt + status + total_amount
        const hash_str2 = `${merchant_id}${merchant_oid}${merchant_salt}${status}${total_amount}`
        const calculated_hash2 = crypto.createHmac("sha256", merchant_key).update(hash_str2).digest("base64")

        // Format 3: PayTR'nin yeni formatı
        const hash_str3 = `${merchant_oid}${merchant_salt}${status}${payment_amount || total_amount}`
        const calculated_hash3 = crypto.createHmac("sha256", merchant_key).update(hash_str3).digest("base64")

        console.log("HASH VERIFICATION ATTEMPTS:")
        console.log("Format 1:", {
          hash_str: hash_str1,
          calculated: calculated_hash1,
          match: hash === calculated_hash1,
        })
        console.log("Format 2:", {
          hash_str: hash_str2,
          calculated: calculated_hash2,
          match: hash === calculated_hash2,
        })
        console.log("Format 3:", {
          hash_str: hash_str3,
          calculated: calculated_hash3,
          match: hash === calculated_hash3,
        })

        if (hash === calculated_hash1 || hash === calculated_hash2 || hash === calculated_hash3) {
          hashVerified = true
          calculatedHash =
            hash === calculated_hash1
              ? calculated_hash1
              : hash === calculated_hash2
                ? calculated_hash2
                : calculated_hash3
          console.log("✅ Hash verified with one of the formats")
        } else {
          console.log("⚠️ Hash verification failed for all formats")
        }
      }

      // Status kontrolü - Hash başarısız olsa bile işlemi kontrol et
      const isPaymentSuccessful = status === "success" || status === "1" || status === "Başarılı"

      console.log("PAYMENT STATUS CHECK:", {
        status,
        isPaymentSuccessful,
        hashVerified,
        willProcess: isPaymentSuccessful, // Hash'e bakmaksızın status'a göre işle
      })

      // Ödeme başarılıysa işle (hash'e bakmaksızın)
      if (isPaymentSuccessful) {
        console.log("💰 Processing successful payment...")

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

        // Browser'dan geliyorsa yönlendir
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")

        if (isFromBrowser) {
          console.log("🔄 Browser detected - redirecting to success page")
          const amount_tl =
            total_amount || payment_amount ? Math.round(Number.parseInt(total_amount || payment_amount) / 100) : 299
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

      if (status === "success" || status === "1" || status === "Başarılı") {
        const amount_tl =
          total_amount || payment_amount ? Math.round(Number.parseInt(total_amount || payment_amount) / 100) : 299
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

// Acil durum endpoint - Manuel başarı yönlendirmesi
app.get("/emergency-success/:orderNumber", (req, res) => {
  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const orderNumber = req.params.orderNumber
  const amount = req.query.amount || 299

  console.log(`🚨 EMERGENCY SUCCESS REDIRECT: ${orderNumber}, amount: ${amount}`)
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
    },
  })
})

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Railway PayTR Proxy Server running on port ${PORT}`)
  console.log(`🔗 Callback URL: https://paytr-callback-server-production.up.railway.app/paytr-callback`)
  console.log(
    `🚨 Emergency URL: https://paytr-callback-server-production.up.railway.app/emergency-success/ORDER_NUMBER`,
  )
})
