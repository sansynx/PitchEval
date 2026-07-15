import { NextRequest, NextResponse } from 'next/server'
import { auth } from '@clerk/nextjs/server'
import dbConnect from '../../../../../lib/mongodb'
import Hackathon from '../../../../../lib/models/Hackathon'
import Evaluation from '../../../../../lib/models/Evaluation'
import { escapeCsvCell, sanitizeDownloadFilename } from '../../../../../lib/security'

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
    
    // Find hackathon
    const hackathon = await Hackathon.findOne({ 
      _id: id, 
      userId 
    })

    if (!hackathon) {
      return NextResponse.json({ error: 'Hackathon not found' }, { status: 404 })
    }

    // Get completed evaluations
    const evaluations = await Evaluation.find({
      hackathonId: id,
      status: 'completed'
    }).sort({ 'scores.overall': -1 })

    // Separate relevant and discarded evaluations
    const relevantEvaluations = evaluations.filter(e => 
      // Include if: no track relevance check OR track is relevant AND overall score > 0
      (!e.trackRelevance || e.trackRelevance.isRelevant !== false) && 
      (e.scores?.overall || 0) > 0
    )
    const discardedEvaluations = evaluations.filter(e => 
      // Include if: track is irrelevant OR overall score is 0 (invalid file)
      (e.trackRelevance && e.trackRelevance.isRelevant === false) ||
      (e.scores?.overall || 0) === 0
    )

    // Create CSV content with simplified columns
    const csvHeaders = [
      'Status',
      'Rank',
      'File Name',
      'Overall Score',
      'Feasibility',
      'Innovation', 
      'Impact',
      'Clarity',
      'Matched Tracks',
      'Discard Reason',
      'Evaluated Date'
    ]

    // Ranked evaluations
    const rankedRows = relevantEvaluations.map((evaluation, index) => [
      'RANKED',
      index + 1,
      evaluation.fileName,
      evaluation.scores?.overall?.toFixed(1) || 'N/A',
      evaluation.scores?.feasibility?.toFixed(1) || 'N/A',
      evaluation.scores?.innovation?.toFixed(1) || 'N/A',
      evaluation.scores?.impact?.toFixed(1) || 'N/A',
      evaluation.scores?.clarity?.toFixed(1) || 'N/A',
      evaluation.trackRelevance?.matchedTracks?.join('; ') || 'All Tracks',
      '', // No discard reason for ranked items
      new Date(evaluation.createdAt).toLocaleDateString()
    ])

    // Discarded evaluations
    const discardedRows = discardedEvaluations.map((evaluation) => [
      'DISCARDED',
      'N/A',
      evaluation.fileName,
      evaluation.scores?.overall?.toFixed(1) || '0.0',
      evaluation.scores?.feasibility?.toFixed(1) || '0.0',
      evaluation.scores?.innovation?.toFixed(1) || '0.0',
      evaluation.scores?.impact?.toFixed(1) || '0.0',
      evaluation.scores?.clarity?.toFixed(1) || '0.0',
      'None',
      evaluation.trackRelevance?.reason || evaluation.suggestions?.[0] || 'Invalid file type',
      new Date(evaluation.createdAt).toLocaleDateString()
    ])

    const csvRows = [...rankedRows, ...discardedRows]

    const csvContent = [
      csvHeaders.map(escapeCsvCell).join(','),
      ...csvRows.map(row => row.map(escapeCsvCell).join(','))
    ].join('\n')

    return new NextResponse(csvContent, {
      headers: {
        'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="${sanitizeDownloadFilename(hackathon.name, 'hackathon')}_results.csv"`
      }
    })

  } catch (error) {
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
