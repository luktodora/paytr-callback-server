const express = require("express")
const bodyParser = require("body-parser")
const crypto = require("crypto")
const fetch = require("node-fetch")
const cors = require("cors")

const app = express()
const PORT = process.env.PORT || 3000

// CORS ayarları
app.use(cors())

// Body parser middleware
app.use(bodyParser.urlencoded({ extended: true }))
app.use(bodyParser.json())

// Ana sayfa
app.get("/", (req, res) => {
  res.send("PayTR Callback Server is running")
})

// PayTR callback endpoint
app.post("/paytr-callback", async (req, res) => {
  console.log("=== PAYTR CALLBACK RECEIVED ===")
  console.log("Timestamp:", new Date().toISOString())
  console.log("Headers:", req.headers)
  console.log("Body:", req.body)

  try {
    // PayTR'den gelen veriler
    const { merchant_oid, status, total_amount, hash } = req.body

    if (!merchant_oid || !status || !total_amount || !hash) {
      console.error("Missing required fields in callback")
      return res.status(400).send("MISSING_PARAMS")
    }

    // Hash doğrulama
    const merchant_key = process.env.PAYTR_MERCHANT_KEY
    const merchant_salt = process.env.PAYTR_MERCHANT_SALT

    if (!merchant_key || !merchant_salt) {
      console.error("PayTR credentials missing")
      return res.status(500).send("CONFIG_ERROR")
    }

    const hash_str = `${merchant_oid}${merchant_salt}${status}${total_amount}`
    const calculated_hash = crypto.createHmac("sha256", merchant_key).update(hash_str).digest("base64")

    console.log("Hash verification:", {
      received_hash: hash,
      calculated_hash,
      match: hash === calculated_hash,
    })

    if (hash !== calculated_hash) {
      console.error("❌ Hash verification FAILED")
      return res.status(400).send("HASH_MISMATCH")
    }

    // Sipariş durumunu işle
    if (status === "success") {
      console.log(`✅ Payment SUCCESS for order: ${merchant_oid}`)
      console.log(`💰 Amount: ${total_amount} kuruş`)

      // Ana uygulamaya bildirim gönder
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

      try {
        // Siparişi tamamla
        const completeOrderResponse = await fetch(`${baseUrl}/api/orders`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            orderNumber: merchant_oid,
            amount: Math.round(Number.parseInt(total_amount) / 100), // Kuruştan TL'ye çevir
            status: "completed",
            paymentMethod: "paytr",
          }),
        })

        if (completeOrderResponse.ok) {
          console.log("✅ Order completed successfully")
        } else {
          console.error("❌ Failed to complete order")
        }

        // Kullanıcıyı başarılı sayfasına yönlendir
        console.log(
          `✅ Redirecting to success page: ${baseUrl}/odeme/basarili?siparis=${merchant_oid}&amount=${total_amount}`,
        )

        // PayTR'ye OK yanıtı döndür
        return res.send("OK")
      } catch (error) {
        console.error("Error processing order:", error)
        return res.send("OK") // Yine de OK döndür
      }
    } else {
      console.log(`❌ Payment FAILED for order: ${merchant_oid}`)

      // Kullanıcıyı başarısız sayfasına yönlendir
      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"
      console.log(`❌ Redirecting to fail page: ${baseUrl}/odeme/basarisiz?siparis=${merchant_oid}&status=failed`)

      // PayTR'ye OK yanıtı döndür
      return res.send("OK")
    }
  } catch (error) {
    console.error("Callback error:", error)
    // Hata durumunda bile OK döndür
    return res.send("OK")
  }
})

// GET istekleri için de aynı endpoint
app.get("/paytr-callback", (req, res) => {
  console.log("=== PAYTR CALLBACK GET ===")
  console.log("Query:", req.query)

  const { merchant_oid, status } = req.query
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || "https://mapsyorum.com.tr"

  if (status === "success") {
    res.redirect(`${baseUrl}/odeme/basarili?siparis=${merchant_oid || "UNKNOWN"}`)
  } else {
    res.redirect(`${baseUrl}/odeme/basarisiz?siparis=${merchant_oid || "UNKNOWN"}&status=${status || "failed"}`)
  }
})

// Server'ı başlat
app.listen(PORT, () => {
  console.log(`PayTR Callback Server running on port ${PORT}`)
})
