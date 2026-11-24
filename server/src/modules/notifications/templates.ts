export const NOTIFICATION_EVENTS = [
  'request.created', 'request.approved', 'job.assigned', 'job.dispatched', 'job.reminder', 'job.rescheduled', 'job.completed',
  'quotation.sent', 'quotation.approved', 'invoice.issued', 'payment.received', 'payment.failed', 'amc.visit_upcoming', 'amc.expiring',
  'user.invited',
] as const;
export type NotificationEvent = (typeof NOTIFICATION_EVENTS)[number];

type T = { event: NotificationEvent; channel: 'email' | 'whatsapp' | 'sms' | 'in_app'; subject?: string; body: string; whatsappTemplate?: string };
const both = (event: NotificationEvent, subject: string, body: string, wa?: string): T[] => [
  { event, channel: 'email', subject, body },
  { event, channel: 'whatsapp', body, whatsappTemplate: wa ?? event.replace('.', '_') },
  { event, channel: 'sms', body },
];

/** Platform default templates. Tenants override per event/channel. Variables use {{dot.path}}. */
export const DEFAULT_TEMPLATES: T[] = [
  ...both('request.created', 'We received your service request {{request.number}}',
    'Hi {{customer.name}}, thank you for contacting {{business.name}}. Your request {{request.number}} has been received and our team will review it shortly.'),
  ...both('request.approved', 'Your service request {{request.number}} is approved',
    'Hi {{customer.name}}, your request {{request.number}} has been approved. We will confirm the visit schedule soon.'),
  ...both('job.assigned', 'Technician assigned for job {{job.number}}',
    'Hi {{customer.name}}, {{technician.name}} has been assigned to your job {{job.number}} scheduled for {{job.scheduled}}.'),
  ...both('job.dispatched', 'Your technician is on the way',
    'Hi {{customer.name}}, {{technician.name}} from {{business.name}} is on the way for job {{job.number}}.'),
  ...both('job.reminder', 'Reminder: service visit {{job.scheduled}}',
    'Hi {{customer.name}}, a reminder of your service visit ({{job.number}}) on {{job.scheduled}}.'),
  ...both('job.rescheduled', 'Your service visit was rescheduled',
    'Hi {{customer.name}}, job {{job.number}} has been rescheduled to {{job.scheduled}}.'),
  ...both('job.completed', 'Service completed — {{job.number}}',
    'Hi {{customer.name}}, job {{job.number}} has been completed. Thank you for choosing {{business.name}}. We would value your feedback: {{links.feedback}}'),
  ...both('quotation.sent', 'Quotation {{quotation.number}} from {{business.name}}',
    'Hi {{customer.name}}, please review quotation {{quotation.number}} for {{quotation.total}}: {{links.quotation}}'),
  ...both('quotation.approved', 'Quotation {{quotation.number}} approved',
    'Hi {{customer.name}}, thank you for approving quotation {{quotation.number}}.'),
  ...both('invoice.issued', 'Invoice {{invoice.number}} from {{business.name}}',
    'Hi {{customer.name}}, invoice {{invoice.number}} for {{invoice.total}} is due on {{invoice.due_date}}. View and pay: {{links.invoice}}'),
  ...both('payment.received', 'Payment received — thank you',
    'Hi {{customer.name}}, we received {{payment.amount}} against invoice {{invoice.number}}. Receipt: {{payment.receipt_number}}.'),
  ...both('payment.failed', 'Payment failed for invoice {{invoice.number}}',
    'Hi {{customer.name}}, your payment for invoice {{invoice.number}} could not be completed. Please try again: {{links.invoice}}'),
  ...both('amc.visit_upcoming', 'Upcoming maintenance visit',
    'Hi {{customer.name}}, your maintenance visit under contract {{amc.number}} is due on {{visit.due_date}}.'),
  ...both('amc.expiring', 'Your maintenance contract {{amc.number}} expires soon',
    'Hi {{customer.name}}, your contract {{amc.number}} expires on {{amc.end_date}}. Contact us to renew.'),
  { event: 'user.invited', channel: 'email', subject: 'You have been invited to {{business.name}} on NEXUS ServiceFlow',
    body: 'Hi {{user.name}}, you have been invited to join {{business.name}}. Accept the invitation: {{links.invite}}' },
];

export function renderTemplate(tpl: string, vars: Record<string, unknown>): string {
  return tpl.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const v = path.split('.').reduce<any>((o, k) => (o == null ? undefined : o[k]), vars);
    return v === undefined || v === null ? '' : String(v);
  });
}
