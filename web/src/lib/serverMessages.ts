import { tk } from './i18n';

/**
 * Server messages that technicians and customers commonly see. API errors are passed through t()
 * on arrival (see api.ts), so listing them here (tk) puts them in the translation catalogs.
 */
export const SERVER_MESSAGES = [
  tk('Something went wrong. Please try again.'), tk('Request failed'), tk('Validation failed'), tk('Too many requests'),
  tk('Too many attempts, please wait a minute.'), tk('Invalid email or password'), tk('Invalid authentication code'), tk('Invalid code'),
  tk('Session expired'), tk('Session revoked'), tk('Session is no longer valid'), tk('No session'), tk('Access denied'),
  tk('Too many failed attempts. Try again in 15 minutes or reset your password.'),
  tk('If an account exists for this email, a reset link has been sent.'), tk('This link is invalid or has expired'),
  tk('This invitation is invalid or has expired'), tk('Current password is incorrect'), tk('Password is incorrect'),
  tk('An account with this email already exists. Try signing in or resetting your password.'),
  tk('Customer portal access only'), tk('Online requests are not enabled for this business'), tk('Business not found'),
  tk('This technician already has a job in that time slot.'), tk('This job was changed by someone else. Refresh and try again.'),
  tk('Add the work performed (service report) before completing the job'), tk('A reason is required to put a job on hold'),
  tk('Technicians cannot set this status'), tk('Assign a technician first'), tk('Parts can be recorded once the job is assigned'),
  tk('Parts on an invoiced job cannot be changed'), tk('Description is required for non-catalogue parts'), tk('Inventory item not found'),
  tk('Insufficient stock for this operation.'), tk('Complete the service report before collecting the customer signature'),
  tk('This report has already been signed'), tk('The customer has signed this report; it can no longer be edited'),
  tk('The service report is locked for this job'), tk('Invalid signature image'), tk('Feedback can be left once the job is completed'),
  tk('This job can no longer be changed online. Please contact us.'), tk('This ticket is closed. Open a new one.'),
  tk('Equipment does not belong to this customer'), tk('Service address does not belong to this customer'),
  tk('A record with these details already exists.'), tk('Endpoint not found'), tk('Malformed JSON body'),
  tk('Support sessions are read-only'), tk('Choose which business to sign in to.'),
  tk('Account created. Check your email to verify your address before signing in.'), tk('This email belongs to several businesses. Choose one.'),
  tk('Password updated. Please sign in.'), tk('Email verified.'),
];
