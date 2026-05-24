import { Env } from '../types'
import { drizzle } from 'drizzle-orm/d1'
import { messages, emails, webhooks } from '../app/lib/schema'
import { eq, sql } from 'drizzle-orm'
import PostalMime from 'postal-mime'
import { WEBHOOK_CONFIG } from '../app/config/webhook'
import { EmailMessage } from '../app/lib/webhook'

function describeError(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
  }

  return {
    message: String(error),
  }
}

const handleEmail = async (message: ForwardableEmailMessage, env: Env) => {
  const db = drizzle(env.DB, { schema: { messages, emails, webhooks } })

  const parsedMessage = await PostalMime.parse(message.raw)

  console.log("Inbound email parsed", {
    from: message.from,
    to: message.to,
    subject: parsedMessage.subject || null,
    hasText: Boolean(parsedMessage.text),
    hasHtml: Boolean(parsedMessage.html),
  })

  try {
    const targetEmail = await db.query.emails.findFirst({
      where: eq(sql`LOWER(${emails.address})`, message.to.toLowerCase())
    })

    if (!targetEmail) {
      console.error("Inbound email target not found", {
        from: message.from,
        to: message.to,
      })
      return
    }

    const savedMessage = await db.insert(messages).values({
      emailId: targetEmail.id,
      fromAddress: message.from,
      subject: parsedMessage.subject || '(无主题)',
      content: parsedMessage.text || '',
      html: parsedMessage.html || '',
      type: 'received',
    }).returning().get()

    const webhook = await db.query.webhooks.findFirst({
      where: eq(webhooks.userId, targetEmail!.userId!)
    })

    if (webhook?.enabled) {
      try {
        const webhookResponse = await fetch(webhook.url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Event': WEBHOOK_CONFIG.EVENTS.NEW_MESSAGE
          },
          body: JSON.stringify({
            emailId: targetEmail.id,
            messageId: savedMessage.id,
            fromAddress: savedMessage.fromAddress,
            subject: savedMessage.subject,
            content: savedMessage.content,
            html: savedMessage.html,
            receivedAt: savedMessage.receivedAt.toISOString(),
            toAddress: targetEmail.address
          } as EmailMessage)
        })

        if (!webhookResponse.ok) {
          console.error("Webhook returned a non-success response", {
            emailId: targetEmail.id,
            messageId: savedMessage.id,
            status: webhookResponse.status,
            statusText: webhookResponse.statusText,
          })
        }
      } catch (error) {
        console.error('Failed to send webhook:', {
          emailId: targetEmail.id,
          messageId: savedMessage.id,
          error: describeError(error),
        })
      }
    }

    console.log("Email processed", {
      emailId: targetEmail.id,
      messageId: savedMessage.id,
      to: targetEmail.address,
      subject: parsedMessage.subject || null,
    })
  } catch (error) {
    console.error('Failed to process email:', {
      from: message.from,
      to: message.to,
      error: describeError(error),
    })
  }
}

const worker = {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await handleEmail(message, env)
  }
}

export default worker
