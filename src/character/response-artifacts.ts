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

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function asRecordArray(value: unknown): Record<string, unknown>[] | null {
  if (!Array.isArray(value)) return null

  const records = value
    .map(item => asRecord(item))
    .filter((item): item is Record<string, unknown> => item !== null)

  return records.length > 0 ? records : null
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' ? value : undefined
}

function getNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key]
  return typeof value === 'number' ? value : undefined
}

export function extractMediaFromToolResult(
  toolName: string | null | undefined,
  rawData: unknown,
): ResponseMedia[] | undefined {
  if (normalizeToolName(toolName) !== 'search_places') return undefined
  const data = asRecord(rawData)
  if (!data) return undefined

  const imageRecords = asRecordArray(data.images)
  if (imageRecords) {
    const media = imageRecords
      .filter(img => {
        const url = getString(img, 'url')
        return typeof url === 'string' && !isMapPreviewUrl(url)
      })
      .slice(0, 6)
      .map(img => ({
        type: 'photo' as const,
        url: getString(img, 'url') ?? '',
        caption: getString(img, 'caption'),
      }))
    if (media.length > 0) return media
  }

  const results = asRecordArray(data.raw) ?? asRecordArray(rawData)
  if (!results) return undefined

  const media: ResponseMedia[] = []

  for (const result of results) {
    const items = asRecordArray(result.items)
    if (!items) continue
    for (const item of items) {
      const imageUrl = getString(item, 'imageUrl')
      if (typeof imageUrl !== 'string' || media.length >= 5) continue
      const badge = item.isBestseller === true ? ' ⭐ BESTSELLER' : ''
      media.push({
        type: 'photo',
        url: imageUrl,
        caption: `${getString(item, 'name') ?? 'Item'} — ₹${String(item.price ?? '?')}${badge}\n📍 ${getString(result, 'restaurant') ?? 'Unknown place'} (${getString(result, 'platform') ?? 'Unknown'})`,
      })
    }
  }

  return media.length > 0 ? media : undefined
}

export function extractVenuesFromToolResult(
  toolName: string | null | undefined,
  rawData: unknown,
): ResponseVenue[] | undefined {
  const normalizedTool = normalizeToolName(toolName)
  const data = asRecord(rawData)
  if (!data) return undefined

  if (normalizedTool === 'search_places') {
    const places = asRecordArray(data.raw) ?? asRecordArray(rawData)
    if (!places) return undefined

    const venues: ResponseVenue[] = []
    for (const place of places.slice(0, 3)) {
      const displayName = asRecord(place.displayName)
      const location = asRecord(place.location)
      const name = getString(displayName ?? {}, 'text') ?? getString(place, 'name')
      const address = getString(place, 'formattedAddress') ?? getString(place, 'address') ?? ''
      const lat = getNumber(location ?? {}, 'latitude') ?? getNumber(location ?? {}, 'lat')
      const lng = getNumber(location ?? {}, 'longitude') ?? getNumber(location ?? {}, 'lng')
      if (name && typeof lat === 'number' && typeof lng === 'number') {
        venues.push({ name, address, lat, lng })
      }
    }
    return venues.length > 0 ? venues : undefined
  }

  if (normalizedTool === 'get_directions') {
    const raw = asRecord(data.raw)
    const routes = asRecordArray(raw?.routes) ?? asRecordArray(data.routes)
    if (!routes || routes.length === 0) return undefined
    const firstRoute = routes[0]
    const legs = asRecordArray(firstRoute.legs)
    const leg = legs?.[legs.length - 1]
    const endLocation = leg ? asRecord(leg.end_location) : null
    if (!leg || !endLocation) return undefined
    return [{
      name: getString(leg, 'end_address')?.split(',')[0] || 'Destination',
      address: getString(leg, 'end_address') ?? '',
      lat: getNumber(endLocation, 'lat') ?? 0,
      lng: getNumber(endLocation, 'lng') ?? 0,
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
