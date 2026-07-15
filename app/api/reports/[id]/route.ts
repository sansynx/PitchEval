import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '../../../../lib/mongodb'
import Evaluation from '../../../../lib/models/Evaluation'
import { generatePDFReport } from '../../../../lib/reportGenerator'
import { sanitizeDownloadFilename } from '../../../../lib/security'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const { id } = await params
    await dbConnect()
    
    const evaluation = await Evaluation.findOne({ 
      _id: id, 
      userId,
      status: 'completed'
    })

    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 })
    }

    const pdfBuffer = await generatePDFReport(evaluation)

    return new NextResponse(pdfBuffer as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${sanitizeDownloadFilename(evaluation.fileName.replace(/\.[^/.]+$/, ''), 'PitchEval')}_PitchEval_report.pdf"`,
      },
    })

  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
