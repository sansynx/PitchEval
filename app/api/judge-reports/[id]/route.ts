import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '@/lib/mongodb'
import Evaluation from '@/lib/models/Evaluation'
import Hackathon from '@/lib/models/Hackathon'
import { generateJudgeReport } from '@/lib/judgeReportGenerator'
import { sanitizeDownloadFilename } from '@/lib/security'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { userId } = await auth()
    
    if (!userId) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    await dbConnect()

    const { id } = await params
    
    const evaluation = await Evaluation.findOne({
      _id: id,
      userId,
      status: 'completed'
    })

    if (!evaluation) {
      return NextResponse.json({ error: 'Evaluation not found' }, { status: 404 })
    }

    // Get hackathon name if this is a hackathon evaluation
    let hackathonName = undefined
    if (evaluation.hackathonId) {
      const hackathon = await Hackathon.findById(evaluation.hackathonId)
      hackathonName = hackathon?.name
    }

    const pdfBuffer = await generateJudgeReport(evaluation, hackathonName)

    const fileName = `${sanitizeDownloadFilename(evaluation.fileName.replace(/\.[^/.]+$/, ''), 'PitchEval')}_Judge_Report.pdf`

    return new NextResponse(pdfBuffer as BodyInit, {
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${fileName}"`,
      },
    })

  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
