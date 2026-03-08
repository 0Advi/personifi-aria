import * as dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(__dirname, '.env') });

const apiKey = process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY;

async function test() {
    console.log('Testing with API KEY:', apiKey ? 'present' : 'MISSING');
    if (!apiKey) return;
    
    const url = 'https://places.googleapis.com/v1/places:searchText';
    const req = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Goog-Api-Key': apiKey,
            'X-Goog-FieldMask': 'places.displayName,places.photos'
        },
        body: JSON.stringify({ textQuery: 'corner house in Bengaluru', maxResultCount: 1 })
    });
    const data = await req.json();
    console.log('Search res ok:', !!data.places);
    
    if (data.places && data.places[0] && data.places[0].photos) {
        const photoName = data.places[0].photos[0].name;
        console.log('Photo name:', photoName);
        const metaUrl = `https://places.googleapis.com/v1/${photoName}/media?key=${apiKey}&maxHeightPx=1600&maxWidthPx=1600&skipHttpRedirect=true`;
        console.log('Fetching meta URL:', metaUrl);
        const metaReq = await fetch(metaUrl);
        const metaData = await metaReq.json();
        console.log('Resolved Photo URI:', metaData.photoUri);
        
        // Let's actually check what's behind the URI
        if (metaData.photoUri) {
             const imgReq = await fetch(metaData.photoUri);
             console.log('Image content-type:', imgReq.headers.get('content-type'));
        }
    }
}
test().catch(console.error);
