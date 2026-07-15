import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import { analyzeTemplateStructure } from '../../../../lib/ai/templateAnalysis'
import { isValidPdfUpload, isWithinRateLimit } from '../../../../lib/security'

export async function POST(request: NextRequest) {
  try {
    const { userId } = await auth()
    if (!userId) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 })
    }

    if (!isWithinRateLimit(`template-analysis:${userId}`, 4, 5 * 60_000)) {
      return NextResponse.json({ success: false, error: 'Too many template analysis requests. Please wait a few minutes.' }, { status: 429 })
    }

    const formData = await request.formData()
    const templateFile = formData.get('templateFile') as File
    const additionalContext = (formData.get('additionalContext') as string | null) ?? ''

    if (!templateFile) {
      return NextResponse.json({
        success: false,
        error: 'Template file is required'
      }, { status: 400 })
    }

    if (additionalContext.length > 2000) {
      return NextResponse.json({ success: false, error: 'Additional context must be 2,000 characters or fewer.' }, { status: 400 })
    }

    // Use the enhanced validation from templateAnalysis
    if (!await isValidPdfUpload(templateFile)) {
      return NextResponse.json({
        success: false,
        error: 'Upload a valid PDF smaller than 10MB.'
      }, { status: 400 })
    }

    // Analyze template structure with enhanced error handling
    const analysis = await analyzeTemplateStructure(templateFile, additionalContext || undefined)

    return NextResponse.json({
      success: true,
      ...analysis
    })

  } catch (error) {
    console.error('Template analysis error:', error)
    
    // Provide user-friendly error messages
    let errorMessage = 'Template analysis failed'
    let statusCode = 500
    
    if (error instanceof Error) {
      errorMessage = error.message
      
      // Determine appropriate status code based on error type
      if (error.message.includes('timeout') || 
          error.message.includes('slides') || 
          error.message.includes('theme') ||
          error.message.includes('corrupted') ||
          error.message.includes('unreadable')) {
        statusCode = 422 // Unprocessable Entity
      }
    }
    
    return NextResponse.json({
      success: false,
      error: errorMessage
    }, { status: statusCode })
  }
}
