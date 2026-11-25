/**
 * Translated platform default templates for customer messages (email / WhatsApp / SMS).
 * Used when a business has not customised a template and its language (tenant locale) is one of these.
 * A tenant's own templates always win. Variables ({{…}}) are identical to the English defaults.
 * Note: WhatsApp template messages still use the pre-approved Meta template for the configured language.
 */
import type { NotificationEvent } from './templates.js';

type Tpl = { subject: string; body: string };
export const TRANSLATED_DEFAULTS: Record<'hi' | 'de' | 'fr' | 'es', Partial<Record<NotificationEvent, Tpl>>> = {
  hi: {
    'request.created': { subject: 'आपका सेवा अनुरोध {{request.number}} प्राप्त हुआ', body: 'नमस्ते {{customer.name}}, {{business.name}} से संपर्क करने के लिए धन्यवाद। आपका अनुरोध {{request.number}} प्राप्त हो गया है, हमारी टीम जल्द ही इसकी समीक्षा करेगी।' },
    'request.approved': { subject: 'आपका सेवा अनुरोध {{request.number}} स्वीकृत', body: 'नमस्ते {{customer.name}}, आपका अनुरोध {{request.number}} स्वीकृत हो गया है। हम जल्द ही विज़िट का समय बताएँगे।' },
    'job.assigned': { subject: 'काम {{job.number}} के लिए तकनीशियन तय', body: 'नमस्ते {{customer.name}}, {{technician.name}} को आपके काम {{job.number}} के लिए {{job.scheduled}} पर असाइन किया गया है।' },
    'job.dispatched': { subject: 'आपके तकनीशियन रास्ते में हैं', body: 'नमस्ते {{customer.name}}, {{business.name}} से {{technician.name}} काम {{job.number}} के लिए रास्ते में हैं।' },
    'job.reminder': { subject: 'याद दिलाना: सेवा विज़िट {{job.scheduled}}', body: 'नमस्ते {{customer.name}}, याद दिला दें कि आपकी सेवा विज़िट ({{job.number}}) {{job.scheduled}} को है।' },
    'job.rescheduled': { subject: 'आपकी सेवा विज़िट का समय बदला गया', body: 'नमस्ते {{customer.name}}, काम {{job.number}} का नया समय {{job.scheduled}} है।' },
    'job.completed': { subject: 'सेवा पूरी हुई — {{job.number}}', body: 'नमस्ते {{customer.name}}, काम {{job.number}} पूरा हो गया है। {{business.name}} चुनने के लिए धन्यवाद। कृपया अपनी प्रतिक्रिया दें: {{links.feedback}}' },
    'quotation.sent': { subject: '{{business.name}} से कोटेशन {{quotation.number}}', body: 'नमस्ते {{customer.name}}, कृपया {{quotation.total}} का कोटेशन {{quotation.number}} देखें: {{links.quotation}}' },
    'quotation.approved': { subject: 'कोटेशन {{quotation.number}} स्वीकृत', body: 'नमस्ते {{customer.name}}, कोटेशन {{quotation.number}} स्वीकृत करने के लिए धन्यवाद।' },
    'invoice.issued': { subject: '{{business.name}} से इनवॉइस {{invoice.number}}', body: 'नमस्ते {{customer.name}}, {{invoice.total}} का इनवॉइस {{invoice.number}} {{invoice.due_date}} तक देय है। देखें और भुगतान करें: {{links.invoice}}' },
    'payment.received': { subject: 'भुगतान प्राप्त हुआ — धन्यवाद', body: 'नमस्ते {{customer.name}}, हमें इनवॉइस {{invoice.number}} के लिए {{payment.amount}} प्राप्त हुए। रसीद: {{payment.receipt_number}}।' },
    'payment.failed': { subject: 'इनवॉइस {{invoice.number}} का भुगतान विफल', body: 'नमस्ते {{customer.name}}, इनवॉइस {{invoice.number}} का आपका भुगतान पूरा नहीं हो सका। कृपया फिर कोशिश करें: {{links.invoice}}' },
    'amc.visit_upcoming': { subject: 'आगामी रखरखाव विज़िट', body: 'नमस्ते {{customer.name}}, अनुबंध {{amc.number}} के तहत आपकी रखरखाव विज़िट {{visit.due_date}} को देय है।' },
    'amc.expiring': { subject: 'आपका रखरखाव अनुबंध {{amc.number}} जल्द समाप्त होगा', body: 'नमस्ते {{customer.name}}, आपका अनुबंध {{amc.number}} {{amc.end_date}} को समाप्त होगा। नवीनीकरण के लिए हमसे संपर्क करें।' },
  },
  de: {
    'request.created': { subject: 'Wir haben Ihre Serviceanfrage {{request.number}} erhalten', body: 'Hallo {{customer.name}}, vielen Dank für Ihre Anfrage bei {{business.name}}. Ihre Anfrage {{request.number}} ist eingegangen und wird in Kürze bearbeitet.' },
    'request.approved': { subject: 'Ihre Serviceanfrage {{request.number}} wurde angenommen', body: 'Hallo {{customer.name}}, Ihre Anfrage {{request.number}} wurde angenommen. Wir bestätigen Ihnen den Termin in Kürze.' },
    'job.assigned': { subject: 'Techniker für Auftrag {{job.number}} zugewiesen', body: 'Hallo {{customer.name}}, {{technician.name}} wurde Ihrem Auftrag {{job.number}} am {{job.scheduled}} zugewiesen.' },
    'job.dispatched': { subject: 'Ihr Techniker ist unterwegs', body: 'Hallo {{customer.name}}, {{technician.name}} von {{business.name}} ist für Auftrag {{job.number}} unterwegs zu Ihnen.' },
    'job.reminder': { subject: 'Erinnerung: Servicetermin {{job.scheduled}}', body: 'Hallo {{customer.name}}, wir erinnern Sie an Ihren Servicetermin ({{job.number}}) am {{job.scheduled}}.' },
    'job.rescheduled': { subject: 'Ihr Servicetermin wurde verschoben', body: 'Hallo {{customer.name}}, der Auftrag {{job.number}} wurde auf {{job.scheduled}} verschoben.' },
    'job.completed': { subject: 'Service abgeschlossen – {{job.number}}', body: 'Hallo {{customer.name}}, der Auftrag {{job.number}} ist abgeschlossen. Vielen Dank, dass Sie sich für {{business.name}} entschieden haben. Wir freuen uns über Ihr Feedback: {{links.feedback}}' },
    'quotation.sent': { subject: 'Angebot {{quotation.number}} von {{business.name}}', body: 'Hallo {{customer.name}}, bitte prüfen Sie das Angebot {{quotation.number}} über {{quotation.total}}: {{links.quotation}}' },
    'quotation.approved': { subject: 'Angebot {{quotation.number}} angenommen', body: 'Hallo {{customer.name}}, vielen Dank für die Annahme des Angebots {{quotation.number}}.' },
    'invoice.issued': { subject: 'Rechnung {{invoice.number}} von {{business.name}}', body: 'Hallo {{customer.name}}, die Rechnung {{invoice.number}} über {{invoice.total}} ist am {{invoice.due_date}} fällig. Ansehen und bezahlen: {{links.invoice}}' },
    'payment.received': { subject: 'Zahlung erhalten – vielen Dank', body: 'Hallo {{customer.name}}, wir haben {{payment.amount}} für die Rechnung {{invoice.number}} erhalten. Beleg: {{payment.receipt_number}}.' },
    'payment.failed': { subject: 'Zahlung für Rechnung {{invoice.number}} fehlgeschlagen', body: 'Hallo {{customer.name}}, Ihre Zahlung für die Rechnung {{invoice.number}} konnte nicht abgeschlossen werden. Bitte versuchen Sie es erneut: {{links.invoice}}' },
    'amc.visit_upcoming': { subject: 'Anstehender Wartungsbesuch', body: 'Hallo {{customer.name}}, Ihr Wartungsbesuch im Rahmen des Vertrags {{amc.number}} ist am {{visit.due_date}} fällig.' },
    'amc.expiring': { subject: 'Ihr Wartungsvertrag {{amc.number}} läuft bald ab', body: 'Hallo {{customer.name}}, Ihr Vertrag {{amc.number}} läuft am {{amc.end_date}} ab. Kontaktieren Sie uns zur Verlängerung.' },
  },
  fr: {
    'request.created': { subject: 'Nous avons reçu votre demande {{request.number}}', body: 'Bonjour {{customer.name}}, merci d’avoir contacté {{business.name}}. Votre demande {{request.number}} a bien été reçue et sera examinée rapidement.' },
    'request.approved': { subject: 'Votre demande {{request.number}} est acceptée', body: 'Bonjour {{customer.name}}, votre demande {{request.number}} a été acceptée. Nous vous confirmerons bientôt la date d’intervention.' },
    'job.assigned': { subject: 'Technicien affecté à l’intervention {{job.number}}', body: 'Bonjour {{customer.name}}, {{technician.name}} a été affecté à votre intervention {{job.number}} prévue le {{job.scheduled}}.' },
    'job.dispatched': { subject: 'Votre technicien est en route', body: 'Bonjour {{customer.name}}, {{technician.name}} de {{business.name}} est en route pour l’intervention {{job.number}}.' },
    'job.reminder': { subject: 'Rappel : intervention le {{job.scheduled}}', body: 'Bonjour {{customer.name}}, nous vous rappelons votre intervention ({{job.number}}) prévue le {{job.scheduled}}.' },
    'job.rescheduled': { subject: 'Votre intervention a été replanifiée', body: 'Bonjour {{customer.name}}, l’intervention {{job.number}} a été replanifiée au {{job.scheduled}}.' },
    'job.completed': { subject: 'Intervention terminée — {{job.number}}', body: 'Bonjour {{customer.name}}, l’intervention {{job.number}} est terminée. Merci d’avoir choisi {{business.name}}. Votre avis nous intéresse : {{links.feedback}}' },
    'quotation.sent': { subject: 'Devis {{quotation.number}} de {{business.name}}', body: 'Bonjour {{customer.name}}, veuillez consulter le devis {{quotation.number}} d’un montant de {{quotation.total}} : {{links.quotation}}' },
    'quotation.approved': { subject: 'Devis {{quotation.number}} accepté', body: 'Bonjour {{customer.name}}, merci d’avoir accepté le devis {{quotation.number}}.' },
    'invoice.issued': { subject: 'Facture {{invoice.number}} de {{business.name}}', body: 'Bonjour {{customer.name}}, la facture {{invoice.number}} d’un montant de {{invoice.total}} est à régler avant le {{invoice.due_date}}. Consulter et payer : {{links.invoice}}' },
    'payment.received': { subject: 'Paiement reçu — merci', body: 'Bonjour {{customer.name}}, nous avons reçu {{payment.amount}} pour la facture {{invoice.number}}. Reçu : {{payment.receipt_number}}.' },
    'payment.failed': { subject: 'Échec du paiement de la facture {{invoice.number}}', body: 'Bonjour {{customer.name}}, votre paiement pour la facture {{invoice.number}} n’a pas abouti. Veuillez réessayer : {{links.invoice}}' },
    'amc.visit_upcoming': { subject: 'Visite d’entretien à venir', body: 'Bonjour {{customer.name}}, votre visite d’entretien au titre du contrat {{amc.number}} est prévue le {{visit.due_date}}.' },
    'amc.expiring': { subject: 'Votre contrat d’entretien {{amc.number}} expire bientôt', body: 'Bonjour {{customer.name}}, votre contrat {{amc.number}} expire le {{amc.end_date}}. Contactez-nous pour le renouveler.' },
  },
  es: {
    'request.created': { subject: 'Hemos recibido tu solicitud {{request.number}}', body: 'Hola, {{customer.name}}: gracias por contactar con {{business.name}}. Hemos recibido tu solicitud {{request.number}} y nuestro equipo la revisará en breve.' },
    'request.approved': { subject: 'Tu solicitud {{request.number}} ha sido aprobada', body: 'Hola, {{customer.name}}: tu solicitud {{request.number}} ha sido aprobada. Te confirmaremos la visita en breve.' },
    'job.assigned': { subject: 'Técnico asignado al trabajo {{job.number}}', body: 'Hola, {{customer.name}}: {{technician.name}} ha sido asignado a tu trabajo {{job.number}} programado para el {{job.scheduled}}.' },
    'job.dispatched': { subject: 'Tu técnico está en camino', body: 'Hola, {{customer.name}}: {{technician.name}}, de {{business.name}}, va de camino para el trabajo {{job.number}}.' },
    'job.reminder': { subject: 'Recordatorio: visita el {{job.scheduled}}', body: 'Hola, {{customer.name}}: te recordamos tu visita de servicio ({{job.number}}) el {{job.scheduled}}.' },
    'job.rescheduled': { subject: 'Tu visita se ha reprogramado', body: 'Hola, {{customer.name}}: el trabajo {{job.number}} se ha reprogramado para el {{job.scheduled}}.' },
    'job.completed': { subject: 'Servicio completado — {{job.number}}', body: 'Hola, {{customer.name}}: el trabajo {{job.number}} se ha completado. Gracias por elegir {{business.name}}. Nos encantaría conocer tu opinión: {{links.feedback}}' },
    'quotation.sent': { subject: 'Presupuesto {{quotation.number}} de {{business.name}}', body: 'Hola, {{customer.name}}: revisa el presupuesto {{quotation.number}} por {{quotation.total}}: {{links.quotation}}' },
    'quotation.approved': { subject: 'Presupuesto {{quotation.number}} aprobado', body: 'Hola, {{customer.name}}: gracias por aprobar el presupuesto {{quotation.number}}.' },
    'invoice.issued': { subject: 'Factura {{invoice.number}} de {{business.name}}', body: 'Hola, {{customer.name}}: la factura {{invoice.number}} por {{invoice.total}} vence el {{invoice.due_date}}. Consúltala y págala: {{links.invoice}}' },
    'payment.received': { subject: 'Pago recibido — gracias', body: 'Hola, {{customer.name}}: hemos recibido {{payment.amount}} de la factura {{invoice.number}}. Recibo: {{payment.receipt_number}}.' },
    'payment.failed': { subject: 'Pago fallido de la factura {{invoice.number}}', body: 'Hola, {{customer.name}}: no se ha podido completar el pago de la factura {{invoice.number}}. Inténtalo de nuevo: {{links.invoice}}' },
    'amc.visit_upcoming': { subject: 'Próxima visita de mantenimiento', body: 'Hola, {{customer.name}}: tu visita de mantenimiento del contrato {{amc.number}} está prevista para el {{visit.due_date}}.' },
    'amc.expiring': { subject: 'Tu contrato de mantenimiento {{amc.number}} vence pronto', body: 'Hola, {{customer.name}}: tu contrato {{amc.number}} vence el {{amc.end_date}}. Contáctanos para renovarlo.' },
  },
};

export const langOf = (locale?: string | null) => (locale ?? 'en').slice(0, 2).toLowerCase();
