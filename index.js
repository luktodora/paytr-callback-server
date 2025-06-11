const express = require("express")
const crypto = require("crypto")

const app = express()
// Railway otomatik olarak PORT'u ayarlar, yoksa 3000 kullan
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

// CORS headers ekle
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*")
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS")
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, Content-Length, X-Requested-With")
  next()
})

// PayTR callback endpoint
app.post("/paytr-callback", async (req, res) => {
  try {
    console.log("=== PayTR CALLBACK RECEIVED ===")
    console.log("Headers:", req.headers)
    console.log("Body:", req.body)

    const { merchant_oid, status, total_amount, hash } = req.body

    // Vercel uygulamanızın URL'si
    const VERCEL_APP_URL = "https://mapsyorum.com.tr"

    if (!merchant_oid || !status || !total_amount || !hash) {
      console.error("Missing required fields")
      return res.status(200).send("OK")
    }

    // Hash doğrulama
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT

    console.log("Environment check:", {
      hasKey: !!merchant_key,
      hasSalt: !!merchant_salt,
      keyLength: merchant_key ? merchant_key.length : 0,
    })

    if (merchant_key && merchant_salt) {
      const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
      const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

      console.log("Hash verification:", {
        received: hash,
        calculated: calculated_hash,
        match: hash === calculated_hash,
      })

      if (hash === calculated_hash) {
        // Hash doğru - Vercel uygulamanıza bildirim gönder
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
              verified: true,
            }),
          })

          if (notificationResponse.ok) {
            console.log("✅ Notification sent to Vercel app successfully")
          } else {
            console.error("❌ Failed to send notification to Vercel app:", await notificationResponse.text())
          }
        } catch (error) {
          console.error("Error sending notification to Vercel:", error)
        }

        // Kullanıcı yönlendirmesi (eğer bu bir browser request'iyse)
        const userAgent = req.headers["user-agent"] || ""
        const isFromBrowser =
          userAgent.includes("Mozilla") || userAgent.includes("Chrome") || userAgent.includes("Safari")

        if (isFromBrowser) {
          console.log("🔄 Browser request detected - redirecting user")

          if (status === "success") {
            const amount_tl = Math.round(Number.parseInt(total_amount) / 100)
            return res.redirect(
              `${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount_tl}&status=success`,
            )
          } else {
            return res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
          }
        }
      } else {
        console.error("❌ Hash verification failed")
      }
    } else {
      console.error("❌ Missing PayTR credentials")
    }

    // PayTR'ye OK yanıtı döndür
    res.status(200).send("OK")
  } catch (error) {
    console.error("Callback error:", error)
    res.status(200).send("OK")
  }
})

// GET istekleri için yönlendirme
app.get("/paytr-callback", (req, res) => {
  console.log("=== PayTR GET CALLBACK ===")
  console.log("Query params:", req.query)

  const VERCEL_APP_URL = "https://mapsyorum.com.tr"
  const { merchant_oid, status, amount } = req.query

  if (status === "success" || status === "1") {
    res.redirect(`${VERCEL_APP_URL}/odeme/basarili?siparis=${merchant_oid}&amount=${amount}&status=success`)
  } else {
    res.redirect(`${VERCEL_APP_URL}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)
  }
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
  console.log(`Environment variables loaded:`, {
    hasPaytrKey: !!process.env.PAYTR_MERCHANT_KEY,
    hasPaytrSalt: !!process.env.PAYTR_MERCHANT_SALT,
  })
})
