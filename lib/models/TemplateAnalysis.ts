import mongoose from 'mongoose'

const TemplateSectionSchema = new mongoose.Schema({
  slideNumber: {
    type: Number,
    required: true,
  },
  title: {
    type: String,
    required: true,
  },
  contentType: {
    type: String,
    enum: ['title', 'introduction', 'problem', 'solution', 'demo', 'market', 'team', 'financials', 'conclusion', 'other'],
    required: true,
  },
  keywords: [String],
}, { _id: false })

const TemplateThemeSchema = new mongoose.Schema({
  primaryTheme: {
    type: String,
    required: true,
  },
  keywords: [String],
  firstSlideContent: {
    type: String,
    required: true,
  },
}, { _id: false })

const TemplateStructureSchema = new mongoose.Schema({
  totalSlides: {
    type: Number,
    required: true,
    min: 1,
  },
  sections: [TemplateSectionSchema],
  expectedPageRange: {
    min: {
      type: Number,
      required: true,
      min: 1,
    },
    max: {
      type: Number,
      required: true,
      min: 1,
    },
  },
}, { _id: false })

const TemplateAnalysisSchema = new mongoose.Schema({
  hackathonId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Hackathon',
    required: false,
  },
  userId: {
    type: String,
    required: true,
  },
  templateFileName: {
    type: String,
    required: true,
  },
  structure: {
    type: TemplateStructureSchema,
    required: true,
  },
  theme: {
    type: TemplateThemeSchema,
    required: true,
  },
  additionalContext: String,
  fingerprint: {
    type: String,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
})

// Create indexes for efficient template lookup
TemplateAnalysisSchema.index({ hackathonId: 1 })
TemplateAnalysisSchema.index({ userId: 1 })
TemplateAnalysisSchema.index({ fingerprint: 1 })
TemplateAnalysisSchema.index({ createdAt: -1 })

// Compound index for hackathon-specific template lookups
TemplateAnalysisSchema.index({ hackathonId: 1, userId: 1 })

export default mongoose.models.TemplateAnalysis || mongoose.model('TemplateAnalysis', TemplateAnalysisSchema)
