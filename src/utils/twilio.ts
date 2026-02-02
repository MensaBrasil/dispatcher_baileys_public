import { config as configDotenv } from "dotenv";
import logger from "./logger.js";
import { getLastCommunication, logCommunication } from "../db/pgsql.js";

configDotenv({ path: ".env" });

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const flowSid = process.env.TWILIO_FLOW_SID;
const twilioWhatsAppNumber = process.env.TWILIO_WHATSAPP_NUMBER;

type TwilioExecutions = {
  create: (args: { to: string; from: string; parameters: Record<string, unknown> }) => Promise<{ sid?: string }>;
};
type TwilioFlows = (sid: string | undefined) => { executions: TwilioExecutions };
type TwilioStudioV2 = { flows: TwilioFlows };
type TwilioClient = { studio: { v2: TwilioStudioV2 } };
type TwilioFactory = (sid: string, token: string) => TwilioClient;

async function getTwilioClient(): Promise<TwilioClient | null> {
  if (!accountSid || !authToken) return null;
  try {
    const imported = (await import("twilio")) as unknown;
    let factory: TwilioFactory | undefined;
    if (typeof (imported as unknown as TwilioFactory) === "function") {
      factory = imported as unknown as TwilioFactory;
    } else {
      const maybeDefault = (imported as { default?: unknown }).default;
      if (typeof maybeDefault === "function") {
        factory = maybeDefault as TwilioFactory;
      }
    }
    if (!factory) return null;
    return factory(accountSid, authToken);
  } catch (err) {
    logger.warn({ err }, "[twilio] module not available; running in no-op mode");
    return null;
  }
}

export async function ensureTwilioClientReadyOrExit(): Promise<void> {
  // Require full configuration: SID, token, flow SID and WhatsApp number
  if (!accountSid || !authToken || !flowSid || !twilioWhatsAppNumber) {
    // Fail fast if environment is not properly configured
    // Using fatal to make it explicit in logs

    logger.fatal(
      {
        hasAccountSid: Boolean(accountSid),
        hasAuthToken: Boolean(authToken),
        hasFlowSid: Boolean(flowSid),
        hasWaNumber: Boolean(twilioWhatsAppNumber),
      },
      "[twilio] missing configuration; exiting",
    );
    process.exit(1);
  }
  const client = await getTwilioClient();
  if (!client) {
    logger.fatal("[twilio] unable to create client; exiting");
    process.exit(1);
  }
}

export async function triggerTwilioOrRemove(phoneNumber: string, reason: string): Promise<boolean> {
  try {
    const waitingBase = Number(process.env.CONSTANT_WAITING_PERIOD ?? 0);
    const waitingPeriod = Number.isFinite(waitingBase) ? waitingBase : 0; // ms
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    const lastComm = await getLastCommunication(phoneNumber);
    const now = new Date();

    const sendTwilio = async (): Promise<void> => {
      await logCommunication(phoneNumber, reason);
      const client = await getTwilioClient();
      if (client && flowSid && twilioWhatsAppNumber) {
        try {
          const execution = await client.studio.v2.flows(flowSid).executions.create({
            to: `whatsapp:+${phoneNumber}`,
            from: `whatsapp:+${twilioWhatsAppNumber}`,
            parameters: { reason, member_phone: `+${phoneNumber}` },
          });
          logger.info({ sid: execution?.sid, phoneNumber, reason }, "[twilio] flow triggered");
        } catch (err) {
          logger.warn({ err }, "[twilio] failed to trigger flow; proceeding with logged communication only");
        }
      } else {
        logger.info({ phoneNumber, reason }, "[twilio] skipped sending (no client configured)");
      }
    };

    if (!lastComm || lastComm.reason !== reason) {
      await sendTwilio();
      return false; // warned, do not remove yet
    }

    const lastCommTime = new Date(lastComm.timestamp);
    const timeElapsed = now.getTime() - lastCommTime.getTime();

    if (timeElapsed > oneWeek) {
      await sendTwilio();
      return false; // warned again
    }

    if (timeElapsed > waitingPeriod) {
      logger.info({ phoneNumber, reason }, "Waiting period ended; should remove");
      return true; // safe to remove
    }

    logger.info({ phoneNumber, reason }, "Waiting period not yet expired; skipping removal");
    return false;
  } catch (error) {
    logger.error({ err: error }, "Error in triggerTwilioOrRemove; defaulting to remove");
    return true; // on error, remove
  }
}

export default { triggerTwilioOrRemove };
