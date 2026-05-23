import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getCorsHeaders } from '../_shared/cors.ts';
import { verifyAuth } from '../_shared/utils.ts';

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || ""
);


serve(async (req) => {
  const corsHeaders = getCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method Not Allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  const auth = await verifyAuth(req);
  if (!auth || !auth.isServiceRole) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
  }

  try {
    const { userId } = await req.json();

    if (!userId) {
      return new Response(JSON.stringify({ error: "Missing userId" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Fetch user email from profiles table (only selecting email since first_name doesn't exist)
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (profileError || !profile?.email) {
      console.error("Error fetching user profile:", profileError);
      return new Response(JSON.stringify({ error: "User profile not found or missing email" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    const email = profile.email;
    const firstName = email.split('@')[0]; // Use email prefix as fallback name

    console.log("Sending payment failure email to:", email);

    const smtpApiKey = Deno.env.get("SMTP_API_KEY");
    const senderEmail = Deno.env.get("SENDER_EMAIL") || "contact@northnoir.com";

    if (!smtpApiKey) {
      console.error("SMTP API key not configured");
      throw new Error("SMTP API key not configured");
    }

    const emailContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Payment Failed - North Noir</title>
</head>
<body style="margin: 0; padding: 0; background-color: #111827; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" style="width: 100%; background-color: #111827;" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #111827; border: 1px solid #000000; margin: 20px auto;" cellpadding="0" cellspacing="0">
          <!-- Header -->
          <tr>
            <td style="padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 28px; margin: 0 0 10px;">Payment Failed</h1>
              <p style="color: #ffffff; font-size: 18px; margin: 0;">Your North Noir subscription has been cancelled</p>
            </td>
          </tr>
          <!-- Main Content -->
          <tr>
            <td style="padding: 20px; color: #ffffff;">
              <h2 style="color: #ffffff; font-size: 22px; margin: 0 0 15px;">Hi${firstName ? ` ${firstName}` : ''}!</h2>
              
              <p style="color: #ffffff; font-size: 16px; line-height: 1.5; margin: 0 0 20px;">
                We're sorry to inform you that your recent payment for North Noir failed and your subscription has been cancelled. Your payment method was declined or expired, so we've cancelled your subscription to prevent further failed payment attempts.
              </p>
              
              <!-- What Happened Section -->
              <table role="presentation" style="width: 100%; margin: 20px 0; background-color: #1f2937; border-left: 4px solid #ff0000; border-radius: 5px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="color: #ff0000; font-size: 18px; margin: 0 0 10px;">What happened?</h3>
                    <p style="color: #ffffff; font-size: 14px; margin: 0;">Your payment method was declined or expired. Your subscription has been cancelled to prevent further failed payment attempts.</p>
                  </td>
                </tr>
              </table>
              
              <!-- Comeback Offer Section -->
              <table role="presentation" style="width: 100%; margin: 20px 0; background-color: #1f2937; border: 2px solid #ff0000; border-radius: 5px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 20px; text-align: center;">
                    <h3 style="color: #ff0000; font-size: 20px; margin: 0 0 10px;">Special Comeback Offer!</h3>
                    <p style="color: #ffffff; font-size: 16px; margin: 0 0 15px;">Ready to return? We'd love to have you back!</p>
                    <p style="color: #ffffff; font-size: 16px; margin: 0 0 15px;"><strong>Get 20% off any plan for up to 3 months</strong></p>
                    <div style="background-color: #ff0000; color: #ffffff; padding: 15px; font-size: 24px; font-weight: bold; letter-spacing: 2px; border-radius: 5px; margin: 10px 0;">Redeem348</div>
                    <p style="color: #ffffff; font-size: 14px; margin: 10px 0 0;">Use this coupon code when you're ready to resubscribe</p>
                  </td>
                </tr>
              </table>
              
              <!-- How to Resubscribe -->
              <h3 style="color: #ffffff; font-size: 20px; margin: 20px 0 10px;">Ready to Resubscribe?</h3>
              <table role="presentation" style="width: 100%; margin: 0 0 20px; background-color: #1f2937; border-radius: 5px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 20px;">
                    <ol style="color: #ffffff; font-size: 14px; line-height: 1.8; margin: 0; padding-left: 20px;">
                      <li>Visit our <a href="https://northnoir.com/pricing" style="color: #ff0000; text-decoration: none;">pricing page</a></li>
                      <li>Choose your preferred plan</li>
                      <li>Enter coupon code <strong style="color: #ff0000;">Redeem348</strong> at checkout</li>
                      <li>Update your payment method if needed</li>
                      <li>Enjoy 20% off for 3 months!</li>
                    </ol>
                  </td>
                </tr>
              </table>
              
              <!-- Support Section -->
              <table role="presentation" style="width: 100%; margin: 20px 0; background-color: #1f2937; border-left: 4px solid #22c55e; border-radius: 5px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="color: #22c55e; font-size: 18px; margin: 0 0 10px;">Need Help?</h3>
                    <p style="color: #ffffff; font-size: 14px; margin: 0;">If you have questions about your payment or need assistance updating your payment method, we're here to help! Contact us at <a href="mailto:contact@northnoir.com" style="color: #ff0000; text-decoration: none;">contact@northnoir.com</a></p>
                  </td>
                </tr>
              </table>
              
              <p style="color: #ffffff; font-size: 16px; line-height: 1.5; margin: 20px 0;">
                Thank you for being part of the North Noir community. We hope to see you back soon!
              </p>
              
              <p style="color: #ffffff; font-size: 16px; margin: 20px 0 0;">
                <strong>Best regards,</strong><br>
                The North Noir Team
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="border-top: 1px solid #000000; padding: 20px; text-align: center;">
              <p style="color: #ffffff; font-size: 12px; margin: 0;">
                North Noir | <a href="https://northnoir.com" style="color: #ff0000; text-decoration: none;">northnoir.com</a><br>
                This email was sent to ${email} regarding your subscription status.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `;

    const requestBody = {
      channel: "north_noir",
      originator: {
        from: {
          name: "North Noir",
          address: senderEmail,
        },
      },
      recipients: {
        to: [
          {
            name: firstName,
            address: email,
          },
        ],
      },
      subject: "Payment Failed - Your North Noir Subscription (20% Off Comeback Offer Inside)",
      body: {
        parts: [
          {
            type: "text/html",
            content: emailContent,
          },
        ],
      },
    };

    console.log("Sending request to SMTP.com API...");

    const response = await fetch("https://api.smtp.com/v4/messages", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${smtpApiKey}`,
        "Content-Type": "application/json",
        "Accept": "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("SMTP.com API error:", errorData);
      throw new Error(`SMTP.com API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log("Payment failure email sent successfully to:", email, "Response:", result);

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });

  } catch (error) {
    console.error("Error sending payment failure email:", error.message);
    console.error("Error stack:", error.stack);
    return new Response(JSON.stringify({ error: `Email sending failed: ${error.message}` }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }
});


