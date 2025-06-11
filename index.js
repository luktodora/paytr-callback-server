const express = require("express")
const crypto = require("crypto")
const fetch = require("node-fetch")

const app = express()
const PORT = process.env.PORT || 3000

// Middleware
app.use(express.urlencoded({ extended: true }))
app.use(express.json())

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

    // Hash doğrulama (PayTR credentials'ları Railway'de environment variable olarak ayarlayın)
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT

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
            console.error("❌ Failed to send notification to Vercel app")
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
  res.json({ status: "OK", timestamp: new Date().toISOString() })
})

app.listen(PORT, () => {
  console.log(`Railway PayTR Proxy Server running on port ${PORT}`)
})
