import { describe, expect, it } from 'vitest'
import { extractResponseArtifacts } from './response-artifacts.js'

describe('extractResponseArtifacts', () => {
  it('normalizes Alpha place_search output into media and venues', () => {
    const result = extractResponseArtifacts('place_search', {
      images: [
        { url: 'https://example.com/place.jpg', caption: 'Nice place' },
        { url: 'https://maps.googleapis.com/maps/api/staticmap?foo=bar', caption: 'Map preview' },
      ],
      raw: [
        {
          displayName: { text: 'Blue Tokai' },
          formattedAddress: 'Indiranagar, Bengaluru',
          location: { latitude: 12.97, longitude: 77.64 },
        },
      ],
    }, 'Indiranagar')

    expect(result.media?.[0]?.url).toBe('https://example.com/place.jpg')
    expect(result.venues?.[0]?.name).toBe('Blue Tokai')
    expect(result.mediaContext?.entityName).toBe('Blue Tokai')
  })

  it('falls back to media context photos when raw images are absent', () => {
    const result = extractResponseArtifacts('event_lookup', {
      raw: [
        {
          displayName: { text: 'The Comedy Club' },
          formattedAddress: 'HSR Layout, Bengaluru',
          location: { latitude: 12.91, longitude: 77.64 },
          photoUrl: 'https://example.com/event.png',
        },
      ],
    })

    expect(result.media?.[0]?.url).toBe('https://example.com/event.png')
    expect(result.venues?.[0]?.address).toContain('HSR Layout')
  })
})
