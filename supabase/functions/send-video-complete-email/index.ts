import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";
import { getCorsHeaders } from "../_shared/cors.ts";

const INTERNAL_WEBHOOK_TOKEN = "vnot_7f3a9b2c1d8e4f6a5b0c3d7e2f1a8b9c";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SECRET_KEY") || "",
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

  // Auth: accept either the internal webhook token (from DB trigger) or service role key
  const webhookToken = req.headers.get("x-internal-webhook");
  const authHeader = req.headers.get("Authorization");
  const serviceRoleKey = Deno.env.get("SECRET_KEY") ?? "";

  const isInternalWebhook = webhookToken === INTERNAL_WEBHOOK_TOKEN;
  const isServiceRole = authHeader === `Bearer ${serviceRoleKey}`;

  if (!isInternalWebhook && !isServiceRole) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  }

  try {
    const { userId, taskId, videoName } = await req.json();

    if (!userId || !taskId) {
      return new Response(JSON.stringify({ error: "Missing userId or taskId" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      });
    }

    // Fetch user email from profiles table
    const { data: profile, error: profileError } = await supabase
      .from("profiles")
      .select("email")
      .eq("id", userId)
      .single();

    if (profileError || !profile?.email) {
      console.error("Error fetching user profile:", profileError);
      return new Response(
        JSON.stringify({ error: "User profile not found or missing email" }),
        {
          status: 400,
          headers: { "Content-Type": "application/json", ...corsHeaders },
        },
      );
    }

    const email = profile.email;
    const displayName = email.split("@")[0];
    const videoTitle = videoName || "your video";
    const videoGeneratorUrl = "https://northnoir.com/video-generator";

    console.log(`Sending video complete email to: ${email} for video: ${videoTitle}`);

    const smtpApiKey = Deno.env.get("SMTP_API_KEY");
    const senderEmail = Deno.env.get("SENDER_EMAIL") || "contact@northnoir.com";

    if (!smtpApiKey) {
      throw new Error("SMTP API key not configured");
    }

    const emailContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Video Is Ready - North Noir</title>
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff; font-family: Arial, Helvetica, sans-serif;">
  <table role="presentation" style="width: 100%; background-color: #ffffff;" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center" style="padding: 32px 16px;">
        <table role="presentation" style="max-width: 600px; width: 100%; background-color: #111111; border-radius: 10px; overflow: hidden;" cellpadding="0" cellspacing="0">
          <!-- Header -->
          <tr>
            <td style="padding: 20px; text-align: center;">
              <h1 style="color: #ffffff; font-size: 28px; margin: 0 0 10px;">Your Video Is Ready</h1>
              <p style="color: #ffffff; font-size: 18px; margin: 0;">North Noir has finished generating your video</p>
            </td>
          </tr>
          <!-- Main Content -->
          <tr>
            <td style="padding: 20px; color: #ffffff;">
              <h2 style="color: #ffffff; font-size: 22px; margin: 0 0 15px;">Hi ${displayName}!</h2>

              <p style="color: #ffffff; font-size: 16px; line-height: 1.5; margin: 0 0 20px;">
                Great news — your video <strong style="color: #ff0000;">${videoTitle}</strong> has finished processing and is now ready for you to download.
              </p>

              <!-- Video Ready Section -->
              <table role="presentation" style="width: 100%; margin: 20px 0; background-color: #1f2937; border-left: 4px solid #ff0000; border-radius: 5px;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding: 20px;">
                    <h3 style="color: #ff0000; font-size: 18px; margin: 0 0 10px;">What's next?</h3>
                    <p style="color: #ffffff; font-size: 14px; margin: 0;">Head over to the Video Generator to preview and download your finished video.</p>
                  </td>
                </tr>
              </table>

              <!-- CTA Button -->
              <table role="presentation" style="width: 100%; margin: 20px 0;" cellpadding="0" cellspacing="0">
                <tr>
                  <td style="text-align: center;">
                    <a href="${videoGeneratorUrl}"
                       style="display: inline-block; background-color: #ff0000; color: #ffffff; font-size: 16px; font-weight: bold; padding: 14px 32px; border-radius: 6px; text-decoration: none;">
                      Go to Video Generator
                    </a>
                  </td>
                </tr>
              </table>

              <p style="color: #ffffff; font-size: 16px; line-height: 1.5; margin: 20px 0 0;">
                <strong>Best regards,</strong><br>
                The North Noir Team
              </p>
            </td>
          </tr>
          <!-- Footer -->
          <tr>
            <td style="border-top: 1px solid #222222; padding: 20px; text-align: center;">
              <p style="color: #ffffff; font-size: 12px; margin: 0;">
                North Noir | <a href="https://northnoir.com" style="color: #ff0000; text-decoration: none;">northnoir.com</a><br>
                This email was sent to ${email} because you requested a notification for this video.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

    const requestBody = {
      channel: "north_noir",
      originator: {
        from: {
          name: "North Noir",
          address: senderEmail,
        },
      },
      recipients: {
        to: [{ name: displayName, address: email }],
      },
      subject: `Your video "${videoTitle}" is ready on North Noir`,
      body: {
        parts: [{ type: "text/html", content: emailContent }],
      },
    };

    const response = await fetch("https://api.smtp.com/v4/messages", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${smtpApiKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(requestBody),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error("SMTP.com API error:", errorData);
      throw new Error(`SMTP.com API error: ${response.status} - ${errorData}`);
    }

    const result = await response.json();
    console.log(`Video complete email sent to ${email} for task ${taskId}`);

    return new Response(JSON.stringify({ success: true, data: result }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders },
    });
  } catch (error: any) {
    console.error("Error sending video complete email:", error.message);
    return new Response(
      JSON.stringify({ error: `Email sending failed: ${error.message}` }),
      {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders },
      },
    );
  }
});
