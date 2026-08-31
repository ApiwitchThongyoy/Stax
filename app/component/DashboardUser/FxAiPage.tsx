import { useState } from "react";
import {
  TrendingUp,
  LineChart,
  WifiOff,
  Calculator,
  Sparkles,
} from "lucide-react";
import PdfStatementUploader from "./PdfStatementUploader";
import type { Transaction } from "../../lib/Financeutils";
import type { ExtractedTransaction } from "../../lib/pdfStatementParser";

interface FxAiPageProps {
  transactions: Transaction[];
  onImport: (imported: ExtractedTransaction[]) => void;
  onDocumentSaved?: () => void;
}

export default function FxAiPage({
  transactions,
  onImport,
  onDocumentSaved,
}: FxAiPageProps) {
  const fxRows = transactions.filter(
    (t) => t.rate && t.rate.trim() !== "" && t.rate !== "-"
  );

  const statusCards: {
    key: string;
    title: string;
    message: string;
    detail: string;
    Icon: typeof WifiOff;
  }[] = [
    {
      key: "bot",
      title: "อัตราแลกเปลี่ยนเรียลไทม์",
      message: "ยังไม่ได้เชื่อมต่อ BOT API",
      detail:
        "อัตราแบบเรียลไทม์จะแสดงที่นี่เมื่อเชื่อมต่อ BOT API กับ backend แล้ว",
      Icon: WifiOff,
    },
    {
      key: "ai",
      title: "ระบบวิเคราะห์ AI",
      message: "เชื่อมต่อ Gemini API พร้อมใช้งาน แล้ว",
      detail:
        "AI ใช้วิเคราะห์โครงสร้างของ Statement เท่านั้น ไม่ได้เป็นผู้คำนวณภาษี",
      Icon: Sparkles,
    },
    {
      key: "tax",
      title: "การคำนวณภาษี",
      message: "Tax Core Engine พร้อมใช้งาน",
      detail:
        "คำนวณรายธุรกรรมแบบกำหนดได้ (deterministic) ด้วยเลขทศนิยม ไม่ให้ขาดทุนหักกลบข้ามรายการ",
      Icon: Calculator,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Banner */}
      <div className="bg-linear-to-br from-blue-900 to-blue-950 rounded-2xl px-6 py-5 text-white">
        <p className="text-xs text-blue-300 mb-1">Foreign Exchange & AI</p>
        <h1 className="text-xl font-semibold mb-1.5">อัตราแลกเปลี่ยน AI</h1>
        <p className="text-sm text-blue-200">
          อัตราแลกเปลี่ยนจาก Statement ที่ import และสถานะการเชื่อมต่อบริการภายนอก
        </p>
      </div>

      {/* Real FX data from imported statements */}
      <div className="bg-white rounded-xl border border-gray-100 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-800">
            อัตราแลกเปลี่ยน ณ วันที่ทำรายการ
          </h2>
          {fxRows.length > 0 && (
            <span className="text-xs text-gray-400">
              {fxRows.length} รายการ · จาก Statement ที่ import
            </span>
          )}
        </div>

        {fxRows.length === 0 ? (
          <div className="px-5 py-12 text-center">
            <LineChart className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              ยังไม่มีข้อมูลอัตราแลกเปลี่ยนจาก Statement ที่ import
            </p>
            <p className="text-xs text-gray-400 mt-1">
              นำเข้า Statement PDF ด้านล่างเพื่อแสดงอัตราที่ใช้จริงในแต่ละรายการ
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400 border-b border-gray-100">
                  <th className="px-5 py-3 font-medium">วันที่</th>
                  <th className="px-5 py-3 font-medium">รายการ</th>
                  <th className="px-5 py-3 font-medium">สกุลเงิน</th>
                  <th className="px-5 py-3 font-medium">อัตรา</th>
                </tr>
              </thead>
              <tbody>
                {fxRows.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-gray-50 last:border-0 hover:bg-gray-50/60 transition"
                  >
                    <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                      {t.date}
                    </td>
                    <td className="px-5 py-3.5">
                      <p className="text-gray-800 font-medium truncate max-w-[260px]">
                        {t.description}
                      </p>
                    </td>
                    <td className="px-5 py-3.5 text-gray-500 whitespace-nowrap">
                      {t.currency}
                    </td>
                    <td className="px-5 py-3.5 text-gray-800 font-medium whitespace-nowrap">
                      {t.rate}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Integration status */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {statusCards.map(({ key, title, message, detail, Icon }) => (
          <div
            key={key}
            className="bg-white rounded-xl border border-gray-100 p-5"
          >
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs text-gray-400">{title}</span>
              <Icon className="w-4 h-4 text-gray-400" />
            </div>
            <p className="text-sm font-medium text-gray-800">{message}</p>
            <p className="text-xs text-gray-400 mt-1.5 leading-relaxed">
              {detail}
            </p>
          </div>
        ))}
      </div>

      {/* AI analysis upload entry */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 p-5 flex items-center justify-center text-center">
          <div>
            <TrendingUp className="w-8 h-8 text-gray-300 mx-auto mb-3" />
            <p className="text-sm font-medium text-gray-600">
              การวิเคราะห์อัตราแลกเปลี่ยนด้วย AI ยังไม่พร้อมใช้งาน
            </p>
            <p className="text-xs text-gray-400 mt-1 max-w-sm mx-auto">
              ระบบจะวิเคราะห์แนวโน้มอัตราแลกเปลี่ยนและให้ข้อเสนอแนะอัตโนมัติ
              หลังเชื่อมต่อ Gemini API
            </p>
          </div>
        </div>
        <PdfStatementUploader
          onImport={onImport}
          onDocumentSaved={onDocumentSaved}
        />
      </div>
    </div>
  );
}