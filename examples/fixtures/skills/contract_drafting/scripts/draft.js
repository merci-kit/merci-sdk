/** @file Contract-drafting skill script: renders a requested clause type (nda/payment/termination/liability/jurisdiction) with party and term placeholders; prints JSON {clause_type, parties, date, terms, clause}. @version 0.7.2 */
const args = JSON.parse(process.argv[2] || '{}');
const clauseType = String(args.clause_type ?? 'general');
const partyA = String(args.party_a ?? 'Party A');
const partyB = String(args.party_b ?? 'Party B');
let terms = {};
try { terms = JSON.parse(args.terms || '{}'); } catch (_) { /* keep defaults */ }

const date = new Date().toISOString().split('T')[0];

const clauses = {
    nda: `CONFIDENTIALITY AND NON-DISCLOSURE AGREEMENT

This Confidentiality and Non-Disclosure Agreement (the "Agreement") is entered into as of ${date} by and between ${partyA} ("Disclosing Party") and ${partyB} ("Receiving Party").

1. Definition of Confidential Information. For purposes of this Agreement, "Confidential Information" shall mean any and all non-public information disclosed by the Disclosing Party to the Receiving Party, whether orally, in writing, or in any other form${terms.duration ? `, during the period commencing on ${date} and ending on ${terms.duration}` : ''}.

2. Obligations of Receiving Party. The Receiving Party agrees to hold the Confidential Information in strict confidence, to use it solely for the purpose of ${terms.purpose || 'evaluating a potential business relationship between the parties'}, and not to disclose it to any third party without the prior written consent of the Disclosing Party.

3. Exclusions. Confidential Information shall not include information that: (a) is or becomes publicly available through no fault of the Receiving Party; (b) was rightfully in the Receiving Party's possession prior to disclosure; (c) is independently developed by the Receiving Party without use of Confidential Information; or (d) is required to be disclosed by law or court order.

4. Term. This Agreement shall remain in effect for a period of ${terms.term || 'two (2) years'} from the date hereof.

5. Governing Law. This Agreement shall be governed by and construed in accordance with the laws of ${terms.jurisdiction || 'the State of Delaware'}.`,

    payment: `PAYMENT TERMS

1. Fees. ${partyB} agrees to pay ${partyA} the total sum of ${terms.amount || '[AMOUNT]'} for the services or goods described in the underlying agreement.

2. Payment Schedule. Payments shall be made as follows: ${terms.schedule || '100% due upon completion of services'}.

3. Late Payments. Any amount not paid within ${terms.grace_period || 'thirty (30) days'} of the due date shall accrue interest at a rate of ${terms.late_rate || '1.5%'} per month.

4. Method of Payment. All payments shall be made via ${terms.method || 'bank transfer'} to an account designated by ${partyA} in writing.

5. Taxes. Each party shall be responsible for its own taxes arising from this agreement unless otherwise specified by applicable law.`,

    termination: `TERMINATION CLAUSE

1. Term. This agreement shall commence on ${date} and continue for a period of ${terms.duration || 'one (1) year'} (the "Initial Term"), and shall automatically renew for successive ${terms.renewal || 'one (1) year'} periods unless terminated in accordance with this clause.

2. Termination for Convenience. Either party may terminate this agreement at any time by providing ${terms.notice_period || 'thirty (30) days'} written notice to the other party.

3. Termination for Cause. Either party may terminate this agreement immediately upon written notice if the other party materially breaches any provision and fails to cure such breach within ${terms.cure_period || 'fifteen (15) days'} of receiving written notice thereof.

4. Effect of Termination. Upon termination, all outstanding fees earned by ${partyA} up to the termination date shall become immediately due and payable.`,

    liability: `LIMITATION OF LIABILITY

1. To the maximum extent permitted by applicable law, neither ${partyA} nor ${partyB} shall be liable to the other for any indirect, incidental, special, consequential, or punitive damages.

2. The total aggregate liability of each party arising out of or related to this agreement shall not exceed ${terms.cap || 'the total fees paid or payable under this agreement during the twelve (12) months preceding the event giving rise to liability'}.

3. The limitations in this clause shall not apply to: (a) breach of confidentiality obligations; (b) infringement of intellectual property rights; or (c) liability that cannot be excluded or limited by applicable law.`,

    jurisdiction: `GOVERNING LAW AND JURISDICTION

This agreement shall be governed by and construed in accordance with the laws of ${terms.jurisdiction || 'the State of Delaware'}, without regard to its conflict of laws principles. Any dispute arising out of or in connection with this agreement shall be subject to the exclusive jurisdiction of the ${terms.court || 'federal and state courts located in Wilmington, Delaware'}. Each party irrevocably submits to such jurisdiction and waives any objection to venue therein.`,
};

const clauseBody = clauses[clauseType.toLowerCase()] || `CLAUSE: ${clauseType.toUpperCase()}\n\nThis is a placeholder clause for "${clauseType}". Customize it as needed.\n\nBetween: ${partyA} and ${partyB}\nTerms: ${JSON.stringify(terms)}`;

const signatureBlock = `\n\n---\nIN WITNESS WHEREOF, the parties have executed this agreement as of ${date}.\n\n${partyA}\nBy: ___________________________\nName:\nTitle:\n\n${partyB}\nBy: ___________________________\nName:\nTitle:`;

const result = {
    clause_type: clauseType,
    parties: { party_a: partyA, party_b: partyB },
    date,
    terms,
    clause: clauseBody + signatureBlock,
};

console.log(JSON.stringify(result));
