import { createHmac, timingSafeEqual } from 'crypto';

/** What the server signs when it creates an invoice checkout. */
export interface StripeCheckoutSignedFields {
  tenantId: number | string;
  saleInvoiceId: number | string;
  paymentLinkId: number | string;
}

const signedText = (fields: StripeCheckoutSignedFields) =>
  [fields.tenantId, fields.saleInvoiceId, fields.paymentLinkId]
    .map((value) => String(value ?? ''))
    .join(':');

/**
 * Signs the checkout's company, invoice and payment link, so the payment
 * notice can prove the checkout was created by this server for that invoice.
 * Anyone can create a checkout with any notes on their own Stripe account,
 * but they can't make this signature.
 * @param {string} secret - The server secret.
 * @param {StripeCheckoutSignedFields} fields
 * @returns {string}
 */
export const signStripeCheckout = (
  secret: string,
  fields: StripeCheckoutSignedFields,
): string =>
  createHmac('sha256', `stripe-checkout:${secret}`)
    .update(signedText(fields))
    .digest('hex');

/**
 * Whether the signature matches the fields.
 * @param {string} secret - The server secret.
 * @param {StripeCheckoutSignedFields} fields
 * @param {string | undefined} signature
 * @returns {boolean}
 */
export const isStripeCheckoutSignatureValid = (
  secret: string,
  fields: StripeCheckoutSignedFields,
  signature: string | undefined,
): boolean => {
  if (!signature || typeof signature !== 'string') return false;
  const expected = Buffer.from(signStripeCheckout(secret, fields));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
};
