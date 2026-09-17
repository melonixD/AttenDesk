export const seed = {
  teachers: [
    {
      id: "teacher-1",
      name: "Dr. Meera Singh",
      employeeCode: "FT-014",
      assignedOfferingIds: ["fluid-food-a", "micro-food-a"]
    }
  ],
  students: [
    { id: "student-1", name: "Aarav Verma", rollNumber: "240101", deviceId: "demo-phone-1", barcode: "HBTU240101", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-2", name: "Ananya Gupta", rollNumber: "240102", deviceId: "demo-phone-2", barcode: "HBTU240102", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-3", name: "Arjun Yadav", rollNumber: "240103", deviceId: "demo-phone-3", barcode: "HBTU240103", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-4", name: "Diya Sharma", rollNumber: "240104", deviceId: "demo-phone-4", barcode: "HBTU240104", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-5", name: "Ishaan Mishra", rollNumber: "240105", deviceId: "demo-phone-5", barcode: "HBTU240105", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-6", name: "Kavya Tiwari", rollNumber: "240106", deviceId: "demo-phone-6", barcode: "HBTU240106", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-7", name: "Rohan Patel", rollNumber: "240107", deviceId: "demo-phone-7", barcode: "HBTU240107", offeringIds: ["fluid-food-a", "micro-food-a"] },
    { id: "student-8", name: "Saanvi Khan", rollNumber: "240108", deviceId: "demo-phone-8", barcode: "HBTU240108", offeringIds: ["fluid-food-a", "micro-food-a"] }
  ],
  offerings: [
    { id: "fluid-food-a", subject: "Fluid Mechanics", code: "FT-201", branch: "Food Technology", section: "A", semester: 3, teacherId: "teacher-1", defaultRoom: "210" },
    { id: "micro-food-a", subject: "Food Microbiology", code: "FT-203", branch: "Food Technology", section: "A", semester: 3, teacherId: "teacher-1", defaultRoom: "211" }
  ],
  historical: [
    { offeringId: "fluid-food-a", studentId: "student-1", attended: 17, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-2", attended: 13, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-3", attended: 15, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-4", attended: 18, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-5", attended: 12, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-6", attended: 16, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-7", attended: 14, conducted: 20 },
    { offeringId: "fluid-food-a", studentId: "student-8", attended: 19, conducted: 20 }
  ]
};
