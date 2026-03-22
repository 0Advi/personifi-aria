import { extractToolMediaContext, type ToolMediaContext } from '../media/tool-media-context.js'

export interface ResponseMedia {
  type: 'photo' | 'video'
  url: string
  caption?: string
}

export interface ResponseVenue {
  name: string
  address: string
  lat: number
  lng: number
}

function normalizeToolName(toolName: string | null | undefined): string | null {
  switch (toolName) {
    case 'place_search':
    case 'event_lookup':
      return 'search_places'
    case 'cab_compare':
      return 'compare_rides'
    case 'food_finder':
      return 'compare_food_prices'
    case 'price_alert':
      return 'compare_prices_proactive'
    case 'weather_check':
      return 'get_weather'
    default:
      return toolName ?? null
  }
}

function isMapPreviewUrl(url: string): boolean {
  return /maps\.googleapis\.com\/maps\/api\/staticmap/i.test(url)
}

export function extractMediaFromToolResult(
  toolName: string | null | undefined,
  rawData: unknown,
): ResponseMedia[] | undefined {
  if (normalizeToolName(toolName) !== 'search_places') return undefined
  if (!rawData || typeof rawData !== 'object') return undefined

  const data = rawData as any

  if (Array.isArray(data?.images)) {
    const media = data.images
      .filter((img: any) => typeof img?.url === 'string' && !isMapPreviewUrl(img.url))
      .slice(0, 6)
      .map((img: any) => ({
        type: 'photo' as const,
        url: img.url,
        caption: img.caption,
      }))
    if (media.length > 0) return media
  }

  const results = data?.raw ?? data
  if (!Array.isArray(results)) return undefined

  const media: ResponseMedia[] = []

  for (const result of results) {
    if (!Array.isArray(result?.items)) continue
    for (const item of result.items) {
      if (typeof item?.imageUrl !== 'string' || media.length >= 5) continue
      const badge = item.isBestseller ? ' ⭐ BESTSELLER' : ''
      media.push({
        type: 'photo',
        url: item.imageUrl,
        caption: `${item.name} — ₹${item.price}${badge}\n📍 ${result.restaurant} (${result.platform})`,
      })
    }
  }

  return media.length > 0 ? media : undefined
}

export function extractVenuesFromToolResult(
  toolName: string | null | undefined,
  rawData: unknown,
): ResponseVenue[] | undefined {
  if (!rawData || typeof rawData !== 'object') return undefined

  const normalizedTool = normalizeToolName(toolName)
  const data = rawData as any

  if (normalizedTool === 'search_places') {
    const places = data?.raw ?? data
    if (!Array.isArray(places)) return undefined

    const venues: ResponseVenue[] = []
    for (const place of places.slice(0, 3)) {
      const name = place.displayName?.text || place.name
      const address = place.formattedAddress || place.address || ''
      const lat = place.location?.latitude ?? place.location?.lat
      const lng = place.location?.longitude ?? place.location?.lng
      if (name && typeof lat === 'number' && typeof lng === 'number') {
        venues.push({ name, address, lat, lng })
      }
    }
    return venues.length > 0 ? venues : undefined
  }

  if (normalizedTool === 'get_directions') {
    const routes = data?.raw?.routes ?? data?.routes
    if (!Array.isArray(routes) || routes.length === 0) return undefined
    const leg = routes[0]?.legs?.[routes[0]?.legs?.length - 1]
    if (!leg?.end_location) return undefined
    return [{
      name: leg.end_address?.split(',')[0] || 'Destination',
      address: leg.end_address || '',
      lat: leg.end_location.lat,
      lng: leg.end_location.lng,
    }]
  }

  return undefined
}

export function buildVenuePreviewMedia(
  venues: ResponseVenue[] | undefined,
  locationLabel?: string | null,
): ResponseMedia[] | undefined {
  if (!venues || venues.length === 0) return undefined
  const first = venues[0]
  const key = process.env.GOOGLE_MAPS_API_KEY
  if (!key) return undefined

  const mapUrl = `https://maps.googleapis.com/maps/api/staticmap?center=${first.lat},${first.lng}&zoom=15&size=900x500&markers=color:red%7C${first.lat},${first.lng}&key=${key}`
  const caption = locationLabel
    ? `📍 ${first.name} (${locationLabel})`
    : `📍 ${first.name}`

  return [{ type: 'photo', url: mapUrl, caption }]
}

export function extractResponseArtifacts(
  toolName: string | null | undefined,
  rawData: unknown,
  locationLabel?: string | null,
): {
  media?: ResponseMedia[]
  venues?: ResponseVenue[]
  mediaContext: ToolMediaContext | null
} {
  const normalizedTool = normalizeToolName(toolName)
  const mediaContext = normalizedTool ? extractToolMediaContext(normalizedTool, rawData) : null
  const directMedia = extractMediaFromToolResult(toolName, rawData)
  const venues = extractVenuesFromToolResult(toolName, rawData)

  const fallbackMedia = (!directMedia && mediaContext?.photoUrls?.length)
    ? mediaContext.photoUrls.slice(0, 5).map(url => ({
      type: 'photo' as const,
      url,
    }))
    : undefined

  const venuePreviewMedia = (!directMedia && !fallbackMedia)
    ? buildVenuePreviewMedia(venues, locationLabel)
    : undefined

  return {
    media: directMedia ?? fallbackMedia ?? venuePreviewMedia,
    venues,
    mediaContext,
  }
}
