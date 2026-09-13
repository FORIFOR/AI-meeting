/** Operator-only inbox via application-default credentials; no public read endpoint. */
import {createRequire} from 'node:module';
const require=createRequire(new URL('../../services/token-broker/package.json',import.meta.url));
const {Firestore}=require('@google-cloud/firestore');
const projectId=process.env.GOOGLE_CLOUD_PROJECT,databaseId=process.env.RCAI_HOSTED_FIRESTORE_DATABASE;
if(!projectId||!databaseId)throw new Error('GOOGLE_CLOUD_PROJECT and RCAI_HOSTED_FIRESTORE_DATABASE are required');
const db=new Firestore({projectId,databaseId});
const [leads,events]=await Promise.all([db.collection('ai_meeting_site_leads').orderBy('createdAt','desc').limit(30).get(),db.collection('ai_meeting_site_events').orderBy('__name__','desc').limit(7).get()]);
const details=process.argv.includes('--details');
console.log(JSON.stringify({inquiries:leads.docs.map(d=>d.data()).filter(d=>d.expiresAt.toMillis()>Date.now()).map(d=>details?{receipt:d.receipt,createdAt:d.createdAt.toDate().toISOString(),name:d.name,email:d.email,organization:d.organization,useCase:d.useCase,message:d.message,status:d.status}:{receipt:d.receipt,createdAt:d.createdAt.toDate().toISOString(),useCase:d.useCase,status:d.status}),dailyEvents:events.docs.map(d=>({day:d.id,counts:d.data().counts})),metricsNote:'Inquiries are saved lead records; GitHub outbound clicks are not GitHub stars. No visitor IDs or form content in event aggregates.'},null,2));
